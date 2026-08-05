import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { NEW_SESSION_TITLE } from "./session-store";

export interface SessionUserMessage {
	id: string;
	text: string;
}

export interface ForkedSession {
	id: string;
	path: string;
	title: string;
	draft: string;
}

export interface PreparedRewind {
	contents: string;
	draft: string;
}

interface SessionHeader extends Record<string, unknown> {
	type: "session";
	id: string;
	cwd: string;
	parentSession?: string;
}

interface SessionEntry extends Record<string, unknown> {
	type: string;
	id?: string;
	parentId?: string | null;
}

interface SessionDocument {
	header: SessionHeader;
	entries: SessionEntry[];
	byId: Map<string, SessionEntry>;
}

interface SessionSelection {
	document: SessionDocument;
	selected: SessionEntry | undefined;
	branch: SessionEntry[];
	draft: string;
}

const NATIVE_DRAFT_DIRECTORY_PREFIX = "pi-vscode-draft-";
const NATIVE_DRAFT_FILE_NAME = "draft";
const SNAPSHOT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

export async function listSessionUserMessages(path: string, leafId?: string): Promise<SessionUserMessage[]> {
	const document = await readSessionDocument(path);
	return branchFor(document, leafId).flatMap((entry) => {
		if (!isUserMessage(entry)) return [];
		const text = extractMessageText(entry.message.content);
		return text.trim() ? [{ id: entry.id, text }] : [];
	});
}

export async function createForkedSession(
	path: string,
	entryId: string | undefined,
	sourceTitle: string,
	leafId?: string,
): Promise<ForkedSession> {
	const selection = await readSessionSelection(path, entryId, leafId);
	const title = await nextForkTitle(path, normalizedTitle(sourceTitle));
	const id = randomUUID();
	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const forkPath = join(dirname(path), `${fileTimestamp}_${id}.jsonl`);
	const header: SessionHeader = {
		type: "session",
		version: typeof selection.document.header.version === "number" ? selection.document.header.version : 3,
		id,
		timestamp,
		cwd: selection.document.header.cwd,
		parentSession: resolve(path),
	};
	const entries = rechainWithoutLabels(branchBefore(selection));
	entries.push(sessionInfo(title, lastEntryId(entries), entries));
	await writeNewSession(forkPath, serializeSession(header, entries));
	return { id, path: forkPath, title, draft: selection.draft };
}

export async function prepareRewindSession(
	path: string,
	entryId: string,
	title: string,
	leafId?: string,
): Promise<PreparedRewind> {
	const selection = await readSessionSelection(path, entryId, leafId);
	const entries = rechainWithoutLabels(branchBefore(selection));
	entries.push(sessionInfo(normalizedTitle(title), lastEntryId(entries), entries));
	return {
		contents: serializeSession(selection.document.header, entries),
		draft: selection.draft,
	};
}

export async function rewriteSessionFile(path: string, contents: string): Promise<void> {
	if (!path.endsWith(".jsonl")) throw new Error(`Not a session transcript: ${path}`);
	const stat = await fs.stat(path);
	const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: stat.mode & 0o777 });
		await fs.rename(temporaryPath, path);
	} catch (error) {
		await fs.unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

export async function createNativeDraftFile(text: string): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), NATIVE_DRAFT_DIRECTORY_PREFIX));
	const path = join(directory, NATIVE_DRAFT_FILE_NAME);
	try {
		await fs.writeFile(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
		return path;
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

export async function removeNativeDraftFile(path: string): Promise<void> {
	if (!isNativeDraftFile(path)) return;
	await fs.rm(dirname(path), { recursive: true, force: true });
}

export async function resolveSessionSnapshot(path: string, entryId: string): Promise<string | undefined> {
	const visited = new Set<string>();
	let currentPath: string | undefined = resolve(path);
	let expectedCwd: string | undefined;
	for (let depth = 0; currentPath && depth < 64; depth++) {
		if (visited.has(currentPath)) break;
		visited.add(currentPath);
		let document: SessionDocument;
		try {
			document = await readSessionDocument(currentPath);
		} catch (error) {
			if (depth > 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		expectedCwd ??= resolve(document.header.cwd);
		if (!samePath(expectedCwd, document.header.cwd)) break;
		const snapshot = snapshotBindings(document.entries).get(entryId);
		if (snapshot) return snapshot;
		const parent = document.header.parentSession;
		currentPath = typeof parent === "string" && parent
			? resolve(isAbsolute(parent) ? parent : join(dirname(currentPath), parent))
			: undefined;
	}
	return undefined;
}

/** Returns true when the current tracked/untracked worktree tree differs from the checkpoint. */
export async function worktreeDiffersFromSnapshot(cwd: string, snapshot: string): Promise<boolean> {
	assertSnapshotSha(snapshot);
	const root = await gitRoot(cwd);
	await runGit(root, ["cat-file", "-e", `${snapshot}^{commit}`]);
	const [currentTree, targetTree] = await Promise.all([
		captureWorktreeTree(root),
		runGit(root, ["show", "-s", "--format=%T", snapshot]).then((value) => value.trim()),
	]);
	return currentTree !== targetTree;
}

/** Restores tracked and untracked, non-ignored files without changing the real index. */
export async function restoreWorktreeSnapshot(cwd: string, snapshot: string): Promise<boolean> {
	assertSnapshotSha(snapshot);
	const root = await gitRoot(cwd);
	await runGit(root, ["cat-file", "-e", `${snapshot}^{commit}`]);
	const currentTree = await captureWorktreeTree(root);
	const targetTree = (await runGit(root, ["show", "-s", "--format=%T", snapshot])).trim();
	if (currentTree === targetTree) return false;

	const deleted = await runGit(root, ["diff", "--name-only", "--diff-filter=D", "-z", currentTree, targetTree, "--"]);
	for (const repoPath of deleted.split("\0").filter(Boolean)) {
		const absolutePath = resolve(root, repoPath);
		const relativePath = relative(root, absolutePath);
		if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${pathSeparator()}`) || isAbsolute(relativePath)) {
			throw new Error(`Refusing to delete a path outside the repository: ${repoPath}`);
		}
		await fs.rm(absolutePath, { recursive: true, force: true });
	}
	await runGit(root, ["restore", `--source=${snapshot}`, "--worktree", "--", "."]);
	return true;
}

async function readSessionSelection(path: string, entryId: string | undefined, leafId?: string): Promise<SessionSelection> {
	const document = await readSessionDocument(path);
	const branch = branchFor(document, leafId);
	let selected: SessionEntry | undefined;
	let draft = "";
	if (entryId) {
		selected = branch.find((entry) => entry.id === entryId);
		if (!selected || !isUserMessage(selected)) throw new Error("The selected user message is no longer in this session branch.");
		draft = extractMessageText(selected.message.content);
		if (!draft.trim()) throw new Error("The selected user message is empty.");
	}
	return { document, selected, branch, draft };
}

async function readSessionDocument(path: string): Promise<SessionDocument> {
	if (!path.endsWith(".jsonl")) throw new Error(`Not a session transcript: ${path}`);
	const contents = await fs.readFile(path, "utf8");
	const records: Record<string, unknown>[] = [];
	for (const [index, line] of contents.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line) as unknown;
			if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("not an object");
			records.push(record as Record<string, unknown>);
		} catch {
			throw new Error(`Invalid session transcript line ${index + 1}.`);
		}
	}
	const [candidate, ...entries] = records;
	if (
		!candidate ||
		candidate.type !== "session" ||
		typeof candidate.id !== "string" ||
		typeof candidate.cwd !== "string"
	) {
		throw new Error("Invalid session header.");
	}
	const typedEntries = entries.filter((entry): entry is SessionEntry => typeof entry.type === "string");
	const byId = new Map<string, SessionEntry>();
	for (const entry of typedEntries) {
		if (typeof entry.id === "string") byId.set(entry.id, entry);
	}
	return { header: candidate as SessionHeader, entries: typedEntries, byId };
}

function branchFor(document: SessionDocument, leafId?: string): SessionEntry[] {
	const fallbackLeaf = [...document.entries].reverse().find((entry) => typeof entry.id === "string")?.id;
	let currentId = leafId && document.byId.has(leafId) ? leafId : fallbackLeaf;
	if (!currentId) return [];
	const reversed: SessionEntry[] = [];
	const visited = new Set<string>();
	while (currentId) {
		if (visited.has(currentId)) throw new Error("Session transcript contains a parent cycle.");
		visited.add(currentId);
		const entry = document.byId.get(currentId);
		if (!entry) throw new Error(`Session entry ${currentId} has a missing parent.`);
		reversed.push(entry);
		currentId = typeof entry.parentId === "string" ? entry.parentId : undefined;
	}
	return reversed.reverse();
}

function branchBefore(selection: SessionSelection): SessionEntry[] {
	const selected = selection.selected;
	if (!selected) {
		const branch = selection.branch;
		while (branch.at(-1)?.type === "session_info") branch.pop();
		return branch;
	}
	const index = selection.branch.findIndex((entry) => entry.id === selected.id);
	if (index < 0) throw new Error("The selected user message is no longer in this session branch.");
	return selection.branch.slice(0, index);
}

function rechainWithoutLabels(entries: SessionEntry[]): SessionEntry[] {
	const result: SessionEntry[] = [];
	let parentId: string | null = null;
	for (const entry of entries) {
		if (entry.type === "label" || typeof entry.id !== "string") continue;
		result.push({ ...entry, parentId });
		parentId = entry.id;
	}
	return result;
}

function isUserMessage(entry: SessionEntry): entry is SessionEntry & {
	id: string;
	message: { role: "user"; content?: unknown };
} {
	if (entry.type !== "message" || typeof entry.id !== "string") return false;
	const message = entry.message;
	return Boolean(message && typeof message === "object" && (message as Record<string, unknown>).role === "user");
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const candidate = part as Record<string, unknown>;
			return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
		})
		.join("");
}

async function nextForkTitle(sourcePath: string, sourceTitle: string): Promise<string> {
	let children = 0;
	let highestNamedIndex = 0;
	const source = resolve(sourcePath);
	for (const entry of await fs.readdir(dirname(sourcePath), { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		try {
			const document = await readSessionDocument(join(dirname(sourcePath), entry.name));
			if (typeof document.header.parentSession !== "string" || !samePath(document.header.parentSession, source)) continue;
			children++;
			const title = latestTitle(document.entries);
			const match = title.match(/^\((\d+)\)\s(.*)$/);
			if (!match || match[2] !== sourceTitle) continue;
			const index = Number.parseInt(match[1], 10);
			if (Number.isSafeInteger(index)) highestNamedIndex = Math.max(highestNamedIndex, index);
		} catch {
			// A sibling can be deleted or still being written while titles are counted.
		}
	}
	return `(${Math.max(children, highestNamedIndex) + 1}) ${sourceTitle}`;
}

function latestTitle(entries: SessionEntry[]): string {
	let title = NEW_SESSION_TITLE;
	for (const entry of entries) {
		if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) title = entry.name.trim();
	}
	return title;
}

function normalizedTitle(title: string): string {
	return title.trim() || NEW_SESSION_TITLE;
}

function sessionInfo(title: string, parentId: string | null, entries: SessionEntry[]): SessionEntry {
	const ids = new Set(entries.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : [])));
	let id = randomUUID().replaceAll("-", "").slice(0, 8);
	while (ids.has(id)) id = randomUUID().replaceAll("-", "").slice(0, 8);
	return { type: "session_info", id, parentId, timestamp: new Date().toISOString(), name: title };
}

function lastEntryId(entries: SessionEntry[]): string | null {
	const id = entries.at(-1)?.id;
	return typeof id === "string" ? id : null;
}

function serializeSession(header: SessionHeader, entries: SessionEntry[]): string {
	return `${[header, ...entries].map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function writeNewSession(path: string, contents: string): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true });
	const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await fs.rename(temporaryPath, path);
	} catch (error) {
		await fs.unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

function snapshotBindings(entries: SessionEntry[]): Map<string, string> {
	const result = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || typeof entry.customType !== "string") continue;
		if (entry.customType === "pi-vscode-rewind") {
			const data = entry.data;
			if (!data || typeof data !== "object") continue;
			const candidate = data as Record<string, unknown>;
			if (typeof candidate.entryId === "string" && typeof candidate.commit === "string" && SNAPSHOT_SHA.test(candidate.commit)) {
				result.set(candidate.entryId, candidate.commit);
			}
			continue;
		}
		if (entry.customType !== "rewind-turn" && entry.customType !== "rewind-op") continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		const candidate = data as Record<string, unknown>;
		if (!Array.isArray(candidate.snapshots) || !Array.isArray(candidate.bindings)) continue;
		for (const binding of candidate.bindings) {
			if (!Array.isArray(binding) || typeof binding[0] !== "string" || !Number.isSafeInteger(binding[1])) continue;
			const snapshot = candidate.snapshots[binding[1] as number];
			if (typeof snapshot === "string" && SNAPSHOT_SHA.test(snapshot)) result.set(binding[0], snapshot);
		}
	}
	return result;
}

function isNativeDraftFile(path: string): boolean {
	const directory = dirname(resolve(path));
	return (
		basename(path) === NATIVE_DRAFT_FILE_NAME &&
		basename(directory).startsWith(NATIVE_DRAFT_DIRECTORY_PREFIX) &&
		dirname(directory) === resolve(tmpdir())
	);
}

async function gitRoot(cwd: string): Promise<string> {
	const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
	if (!root) throw new Error("This workspace is not a Git repository.");
	return root;
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

function assertSnapshotSha(snapshot: string): void {
	if (!SNAPSHOT_SHA.test(snapshot)) throw new Error("Invalid rewind checkpoint.");
}

function samePath(left: string, right: string): boolean {
	const a = resolve(left);
	const b = resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathSeparator(): string {
	return process.platform === "win32" ? "\\" : "/";
}
