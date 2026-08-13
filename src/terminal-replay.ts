import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { terminalLineLinks, type TerminalLineLink } from "./terminal-links";

const Terminal = loadHeadlessTerminal();

export interface TerminalReplaySnapshot {
	data: string;
	sequence: number;
}

/**
 * Mirrors the PTY stream in a headless xterm so a detached native VS Code terminal
 * can be reconstructed without keeping its editor tab alive. The mirror uses the
 * same bounded scrollback model as a real terminal instead of retaining raw output
 * forever, and serialization preserves cursor position, modes, colours and alt-screen.
 */
export class TerminalReplay {
	private readonly terminal: HeadlessTerminal;
	private readonly serializer = new SerializeAddon();
	private writeChain = Promise.resolve();
	private sequence = 0;
	private controlTail = "";
	private kittyKeyboardSequence = "";
	private disposed = false;

	constructor(
		cols = 80,
		rows = 24,
		scrollback = 1000,
	) {
		this.terminal = new Terminal({
			cols,
			rows,
			scrollback,
			allowProposedApi: true,
			vtExtensions: { kittyKeyboard: true },
		});
		// The headless and browser Terminal APIs implement the same addon contract;
		// addon-serialize currently publishes its declaration against @xterm/xterm.
		this.terminal.loadAddon(this.serializer as never);
	}

	write(data: string): number {
		if (this.disposed) return this.sequence;
		this.trackInputProtocol(data);
		const sequence = ++this.sequence;
		this.writeChain = this.writeChain.then(
			() =>
				new Promise<void>((resolve) => {
					if (this.disposed) return resolve();
					this.terminal.write(data, resolve);
				}),
		);
		return sequence;
	}

	resize(cols: number, rows: number): void {
		if (this.disposed) return;
		this.writeChain = this.writeChain.then(() => {
			if (!this.disposed) this.terminal.resize(cols, rows);
		});
	}

	async snapshot(): Promise<TerminalReplaySnapshot> {
		if (this.disposed) return { data: "", sequence: this.sequence };
		// Writes can arrive while an earlier parser batch is draining. Repeat until the
		// sequence is stable so the returned watermark describes exactly this snapshot.
		for (;;) {
			const sequence = this.sequence;
			const writeChain = this.writeChain;
			await writeChain;
			if (this.disposed) return { data: "", sequence: this.sequence };
			if (sequence !== this.sequence || writeChain !== this.writeChain) continue;
			return { data: this.kittyKeyboardSequence + this.serializer.serialize(), sequence };
		}
	}

	async linksForLine(line: string): Promise<TerminalLineLink[]> {
		await this.writeChain;
		if (this.disposed) return [];
		const direct = terminalLineLinks(line);
		const hardWrapped: TerminalLineLink[] = [];
		const buffer = this.terminal.buffer.active;
		for (let requested = buffer.length - 1; requested >= 0; requested--) {
			const requestedText = buffer.getLine(requested)?.translateToString(true);
			if (requestedText === undefined || requestedText.trimEnd() !== line.trimEnd()) continue;
			for (let start = Math.max(0, requested - 64); start <= requested; start++) {
				const expanded = this.hardWrappedLinksFrom(start);
				for (const link of expanded) {
					const segment = link.segments.find((candidate) => candidate.lineIndex === requested);
					if (!segment) continue;
					hardWrapped.push({
						startIndex: segment.startIndex,
						length: segment.length,
						target: link.target,
						kind: link.kind,
					});
				}
			}
			// The newest matching buffer row is the one VS Code is normally asking for;
			// stopping here also avoids duplicate links when identical output repeats.
			break;
		}
		hardWrapped.sort((a, b) => b.target.length - a.target.length);
		const completeHardWrapped = hardWrapped.filter(
			(link, index, links) =>
				!links.slice(0, index).some(
					(candidate) =>
						link.startIndex < candidate.startIndex + candidate.length &&
						candidate.startIndex < link.startIndex + link.length,
				),
		);
		const uncoveredDirect = direct.filter(
			(link) =>
				!completeHardWrapped.some(
					(candidate) =>
						link.startIndex < candidate.startIndex + candidate.length &&
						candidate.startIndex < link.startIndex + link.length,
				),
		);
		return deduplicateLineLinks([...completeHardWrapped, ...uncoveredDirect]);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.serializer.dispose();
		this.terminal.dispose();
	}

	private trackInputProtocol(data: string): void {
		const input = this.controlTail + data;
		for (const match of input.matchAll(/\x1b\[(?:>|<)[0-9:;]*u/g)) {
			this.kittyKeyboardSequence = match[0][2] === ">" ? match[0] : "";
		}
		// A Kitty sequence is short; retaining a small suffix also catches a sequence
		// split across adjacent node-pty data callbacks.
		this.controlTail = input.slice(-64);
	}

	private hardWrappedLinksFrom(startLineIndex: number): Array<{
		target: string;
		kind: "file" | "url";
		segments: Array<{ lineIndex: number; startIndex: number; length: number }>;
	}> {
		const buffer = this.terminal.buffer.active;
		const firstLine = buffer.getLine(startLineIndex);
		if (!firstLine || firstLine.isWrapped) return [];
		const firstText = firstLine.translateToString(true);
		const expanded = [];
		for (const initial of terminalLineLinks(firstText)) {
			let target = initial.target;
			let lineIndex = startLineIndex;
			let text = firstText;
			let endIndex = initial.startIndex + initial.length;
			const segments = [{ lineIndex, startIndex: initial.startIndex, length: initial.length }];
			while (this.reachesRenderedEdge(text, endIndex)) {
				const nextLine = buffer.getLine(lineIndex + 1);
				if (!nextLine || nextLine.isWrapped) break;
				const nextText = nextLine.translateToString(true);
				const trimmed = nextText.trimStart();
				if (/^(?:[-*+]|\d+[.)])\s|^[│├┌└┐┘┤─]|^`{3}/.test(trimmed)) break;
				const startIndex = nextText.length - trimmed.length;
				const fragment = /^[^\s"'`<>()\[\]{}|]+/.exec(trimmed)?.[0];
				if (!fragment) break;
				target += fragment;
				lineIndex++;
				text = nextText;
				endIndex = startIndex + fragment.length;
				segments.push({ lineIndex, startIndex, length: fragment.length });
			}
			if (segments.length === 1) continue;
			const trimmedTarget = target.replace(/[.,;!?]+$/, "");
			segments.at(-1)!.length -= target.length - trimmedTarget.length;
			expanded.push({ target: trimmedTarget, kind: initial.kind, segments });
		}
		return expanded;
	}

	private reachesRenderedEdge(text: string, targetEndIndex: number): boolean {
		return /^ ?$/.test(text.slice(targetEndIndex)) && targetEndIndex >= this.terminal.cols - 1;
	}
}

/**
 * Node 22 exposes `navigator`, and VS Code temporarily wraps it with a migration
 * warning. xterm's environment detector otherwise mistakes the extension host for
 * a browser. Hide that global only while the CommonJS bundle initializes, then put
 * the exact descriptor back before any extension code runs.
 */
function loadHeadlessTerminal(): typeof import("@xterm/headless").Terminal {
	const host = globalThis as Record<string, unknown>;
	const descriptor = Object.getOwnPropertyDescriptor(host, "navigator");
	let replaced = false;
	try {
		if (!descriptor || descriptor.configurable) {
			Object.defineProperty(host, "navigator", { value: undefined, configurable: true, writable: true });
			replaced = true;
		}
		return require("@xterm/headless").Terminal as typeof import("@xterm/headless").Terminal;
	} finally {
		if (replaced) {
			if (descriptor) Object.defineProperty(host, "navigator", descriptor);
			else delete host.navigator;
		}
	}
}

function deduplicateLineLinks(links: TerminalLineLink[]): TerminalLineLink[] {
	const seen = new Set<string>();
	return links.filter((link) => {
		const key = `${link.startIndex}:${link.length}:${link.target}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
