import * as vscode from "vscode";
import type { TerminalReplaySnapshot } from "./terminal-replay";

export interface NativeTerminalBackend {
	replay(): Promise<TerminalReplaySnapshot>;
	input(data: string): void;
	resize(cols: number, rows: number): void;
	close(): void;
}

/** Bridges an owned node-pty process into VS Code's native terminal surface. */
export class PiPseudoterminal implements vscode.Pseudoterminal, vscode.Disposable {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number | void>();
	private readonly nameEmitter = new vscode.EventEmitter<string>();
	private readonly pending: Array<{ data: string; sequence: number; generation: number }> = [];
	private opened = false;
	private didOpen = false;
	private closed = false;
	private ended = false;
	private pendingName: string | undefined;
	private pendingExitCode: number | undefined;
	private dimensions: vscode.TerminalDimensions | undefined;
	private generation = 0;

	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;
	readonly onDidChangeName = this.nameEmitter.event;

	constructor(private backend: NativeTerminalBackend) {}

	open(initialDimensions: vscode.TerminalDimensions | undefined): void {
		if (this.closed || this.didOpen) return;
		this.didOpen = true;
		if (this.pendingName) this.nameEmitter.fire(this.pendingName);
		if (this.ended) {
			this.closeEmitter.fire(this.pendingExitCode);
			this.disposeEmitters();
			return;
		}
		this.dimensions = initialDimensions;
		if (initialDimensions) this.backend.resize(initialDimensions.columns, initialDimensions.rows);
		void this.restore(this.generation, false);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (!this.ended) this.backend.close();
		this.disposeEmitters();
	}

	handleInput(data: string): void {
		if (!this.closed && !this.ended) this.backend.input(data);
	}

	setDimensions(dimensions: vscode.TerminalDimensions): void {
		this.dimensions = dimensions;
		if (!this.closed && !this.ended) this.backend.resize(dimensions.columns, dimensions.rows);
	}

	write(data: string, sequence: number): void {
		if (this.closed || this.ended) return;
		if (this.opened) this.writeEmitter.fire(data);
		else this.pending.push({ data, sequence, generation: this.generation });
	}

	/** Reuses the same native Terminal Editor while displaying a different Pi session. */
	switchBackend(backend: NativeTerminalBackend, name: string): void {
		if (this.closed || this.ended) return;
		this.backend = backend;
		this.generation++;
		this.opened = false;
		this.pending.length = 0;
		this.rename(name);
		if (this.dimensions) backend.resize(this.dimensions.columns, this.dimensions.rows);
		if (this.didOpen) void this.restore(this.generation, true);
	}

	rename(name: string): void {
		if (this.closed || this.ended) return;
		this.pendingName = name;
		if (this.didOpen) this.nameEmitter.fire(name);
	}

	end(exitCode?: number): void {
		if (this.closed || this.ended) return;
		this.ended = true;
		this.pendingExitCode = exitCode;
		if (this.didOpen) {
			this.closeEmitter.fire(exitCode);
			this.disposeEmitters();
		}
	}

	dispose(): void {
		this.end();
	}

	private async restore(generation: number, reset: boolean): Promise<void> {
		const backend = this.backend;
		try {
			const snapshot = await backend.replay();
			if (this.closed || this.ended || generation !== this.generation || backend !== this.backend) return;
			const prefix = reset ? "\x1bc\x1b[3J" : "";
			if (prefix || snapshot.data) this.writeEmitter.fire(prefix + snapshot.data);
			this.opened = true;
			for (const output of this.pending.splice(0)) {
				if (output.generation === generation && output.sequence > snapshot.sequence) this.writeEmitter.fire(output.data);
			}
		} catch {
			if (generation === this.generation && backend === this.backend) this.end(1);
		}
	}

	private disposeEmitters(): void {
		this.pending.length = 0;
		this.writeEmitter.dispose();
		this.closeEmitter.dispose();
		this.nameEmitter.dispose();
	}
}
