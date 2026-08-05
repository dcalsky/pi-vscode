// Loaded only by Pi processes started from the VS Code extension.
// @ts-nocheck

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const socketPath = process.env.PI_VSCODE_STATUS_SOCKET;
const token = process.env.PI_VSCODE_STATUS_TOKEN;
const tabId = process.env.PI_VSCODE_STATUS_TAB_ID;
const sourceId = `pi-vscode:${Date.now()}:${Math.random().toString(36).slice(2)}`;
const nativeDraftFile = process.env.PI_VSCODE_DRAFT_FILE;

const NATIVE_DRAFT_DIRECTORY_PREFIX = "pi-vscode-draft-";
const NATIVE_DRAFT_FILE_NAME = "draft";
const SNAPSHOT_REF = "refs/pi-vscode/rewind";
const ZERO_SHA = "0000000000000000000000000000000000000000";
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

let sequence = 0;
let rootSession = false;
let currentSessionId: string | undefined;
let currentSessionPath: string | undefined;
let currentLeafId: string | undefined;
let lastState: "working" | "idle" | undefined;
let repoRoot: string | undefined;
let checkpointWarningShown = false;
let nativeCheckpointsEnabled = true;

function enabled(): boolean {
	return Boolean(socketPath && token && tabId);
}

function updateSessionRef(ctx: any): void {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		currentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		currentSessionId = undefined;
	}

	try {
		const path = ctx?.sessionManager?.getSessionFile?.();
		currentSessionPath = typeof path === "string" ? path : undefined;
	} catch {
		currentSessionPath = undefined;
	}

	try {
		const id = ctx?.sessionManager?.getLeafId?.();
		currentLeafId = typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		currentLeafId = undefined;
	}
}

function publish(state: "working" | "idle", force = false): void {
	if (!enabled() || !currentSessionId || (!force && state === lastState)) return;
	lastState = state;

	const payload = {
		type: "pi-vscode-status",
		token,
		tabId,
		sessionId: currentSessionId,
		sessionPath: currentSessionPath,
		leafId: currentLeafId,
		state,
		sourceId,
		seq: ++sequence,
	};
	let socket: net.Socket | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const finish = () => {
		if (timeout) clearTimeout(timeout);
		socket?.destroy();
	};

	try {
		socket = net.createConnection(socketPath!);
		socket.once("error", finish);
		socket.once("connect", () => socket?.end(`${JSON.stringify(payload)}\n`));
		socket.once("close", finish);
		timeout = setTimeout(finish, 500);
		timeout.unref?.();
	} catch {
		finish();
	}
}

function isManagedDraftFile(path: string): boolean {
	const directory = dirname(resolve(path));
	return (
		basename(path) === NATIVE_DRAFT_FILE_NAME &&
		basename(directory).startsWith(NATIVE_DRAFT_DIRECTORY_PREFIX) &&
		dirname(directory) === resolve(tmpdir())
	);
}

async function consumeNativeDraft(ctx: any): Promise<void> {
	delete process.env.PI_VSCODE_DRAFT_FILE;
	if (!nativeDraftFile) return;
	try {
		if (!isManagedDraftFile(nativeDraftFile)) throw new Error("Refusing to read an unmanaged VS Code draft");
		const directory = dirname(nativeDraftFile);
		const [directoryStat, fileStat] = await Promise.all([fs.lstat(directory), fs.lstat(nativeDraftFile)]);
		if (!directoryStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
			throw new Error("The VS Code draft is not a regular private file");
		}
		if (typeof process.getuid === "function") {
			const uid = process.getuid();
			if (directoryStat.uid !== uid || fileStat.uid !== uid) throw new Error("The VS Code draft is owned by another user");
		}
		const draft = await fs.readFile(nativeDraftFile, "utf8");
		if (ctx?.mode !== "tui" || typeof ctx?.ui?.setEditorText !== "function") {
			throw new Error("The VS Code draft requires Pi interactive mode");
		}
		ctx.ui.setEditorText(draft);
		await fs.rm(directory, { recursive: true, force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && ctx?.hasUI === true) {
			ctx.ui.notify(`Failed to restore VS Code draft: ${errorMessage(error)}`, "error");
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			args,
			{ cwd, env, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(String(stderr).trim() || error.message));
					return;
				}
				resolvePromise(String(stdout));
			},
		);
	});
}

async function captureWorktreeTree(root: string): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), "pi-vscode-rewind-"));
	try {
		const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
		await runGit(root, ["add", "-A"], env);
		return (await runGit(root, ["write-tree"], env)).trim();
	} finally {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function snapshotCommit(root: string, tree: string): Promise<string> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const current = await runGit(root, ["rev-parse", "--verify", SNAPSHOT_REF]).then(
			(value) => value.trim() || undefined,
			() => undefined,
		);
		if (current) {
			const currentTree = (await runGit(root, ["show", "-s", "--format=%T", current])).trim();
			if (currentTree === tree) return current;
		}
		const identity = {
			...process.env,
			GIT_AUTHOR_NAME: "Pi VS Code",
			GIT_AUTHOR_EMAIL: "pi-vscode@localhost",
			GIT_COMMITTER_NAME: "Pi VS Code",
			GIT_COMMITTER_EMAIL: "pi-vscode@localhost",
		};
		const args = ["commit-tree", tree];
		if (current) args.push("-p", current);
		args.push("-m", "pi vscode rewind snapshot");
		const commit = (await runGit(root, args, identity)).trim();
		const expected = current ?? ZERO_SHA;
		try {
			await runGit(root, ["update-ref", SNAPSHOT_REF, commit, expected]);
			return commit;
		} catch {
			// Another Pi session advanced the shared keepalive ref; retry with its head.
		}
	}
	throw new Error("Failed to update the Pi VS Code rewind checkpoint ref");
}

function existingSnapshot(entries: any[], entryId: string): string | undefined {
	for (const entry of entries) {
		if (entry?.type !== "custom") continue;
		if (entry.customType === "pi-vscode-rewind" && entry.data?.entryId === entryId && typeof entry.data?.commit === "string") {
			return entry.data.commit;
		}
		if ((entry.customType !== "rewind-turn" && entry.customType !== "rewind-op") || !Array.isArray(entry.data?.bindings)) {
			continue;
		}
		for (const binding of entry.data.bindings) {
			if (!Array.isArray(binding) || binding[0] !== entryId || !Number.isSafeInteger(binding[1])) continue;
			const snapshot = entry.data.snapshots?.[binding[1]];
			if (typeof snapshot === "string") return snapshot;
		}
	}
	return undefined;
}

async function captureUserCheckpoint(pi: any, ctx: any): Promise<void> {
	if (!repoRoot || !nativeCheckpointsEnabled) return;
	const branch = ctx?.sessionManager?.getBranch?.();
	if (!Array.isArray(branch)) return;
	const user = [...branch].reverse().find((entry) => entry?.type === "message" && entry?.message?.role === "user");
	if (!user?.id || existingSnapshot(ctx.sessionManager.getEntries?.() ?? branch, user.id)) return;
	const tree = await captureWorktreeTree(repoRoot);
	const commit = await snapshotCommit(repoRoot, tree);
	pi.appendEntry("pi-vscode-rewind", { v: 1, entryId: user.id, commit });
}

async function hasConfiguredRewindHook(): Promise<boolean> {
	const agentDirectory = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	try {
		const settings = JSON.parse(await fs.readFile(join(agentDirectory, "settings.json"), "utf8"));
		const sources = [
			...(Array.isArray(settings?.packages) ? settings.packages : []),
			...(Array.isArray(settings?.extensions) ? settings.extensions : []),
		];
		return sources.some((source) => typeof source === "string" && source.includes("pi-rewind-hook"));
	} catch {
		return false;
	}
}

export default function (pi: any): void {
	pi.on("session_start", async (_event: any, ctx: any) => {
		if (ctx?.hasUI !== true || !enabled()) return;
		rootSession = true;
		await consumeNativeDraft(ctx);
		updateSessionRef(ctx);
		try {
			const result = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
			repoRoot = result?.code === 0 && result.stdout?.trim() ? result.stdout.trim() : undefined;
		} catch {
			repoRoot = undefined;
		}
		nativeCheckpointsEnabled = !(await hasConfiguredRewindHook());
		publish(ctx?.isIdle?.() === false ? "working" : "idle", true);
	});

	pi.on("turn_start", async (event: any, ctx: any) => {
		if (!rootSession || event?.turnIndex !== 0) return;
		try {
			await captureUserCheckpoint(pi, ctx);
		} catch (error) {
			if (!checkpointWarningShown && ctx?.hasUI === true) {
				checkpointWarningShown = true;
				ctx.ui.notify(`Pi VS Code could not create a rewind checkpoint: ${errorMessage(error)}`, "warning");
			}
		}
	});

	pi.on("agent_start", (_event: any, ctx: any) => {
		if (!rootSession) return;
		updateSessionRef(ctx);
		publish("working");
	});

	pi.on("agent_settled", (_event: any, ctx: any) => {
		if (!rootSession || ctx?.isIdle?.() !== true) return;
		updateSessionRef(ctx);
		publish("idle");
	});

	pi.on("session_tree", (_event: any, ctx: any) => {
		if (!rootSession) return;
		updateSessionRef(ctx);
		publish("idle", true);
	});
}
