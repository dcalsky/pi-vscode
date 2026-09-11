import { createReadStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export const NEW_SESSION_TITLE = "New Session";

export interface PiSession {
	id: string;
	path: string;
	title: string;
	createdAtMs: number;
	mtimeMs: number;
}

export interface SessionSearchOptions {
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	sessionDir?: string;
}

interface SessionHeader {
	type?: unknown;
	id?: unknown;
	timestamp?: unknown;
	cwd?: unknown;
}

interface CachedSession extends PiSession {
	cwd: string;
	size: number;
}

const MAX_CONCURRENT_SESSION_READS = 8;
const sessionCache = new Map<string, CachedSession>();

export function encodeWorkspaceDirectory(cwd: string): string {
	const normalized = resolve(cwd);
	return `--${normalized.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

export async function listWorkspaceSessions(cwd: string, options: SessionSearchOptions = {}): Promise<PiSession[]> {
	const search = await sessionSearch(cwd, options);
	const matches = await Promise.all(search.directories.map((directory) => readSessions(directory, search.cwd)));
	const unique = new Map<string, PiSession>();
	for (const session of matches.flat()) unique.set(session.path, session);
	return [...unique.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A session persists as its JSONL transcript plus a sidecar directory of the same name. */
export async function deleteSessionFiles(path: string): Promise<void> {
	if (!path.endsWith(".jsonl")) throw new Error(`Not a session transcript: ${path}`);
	await fs.rm(path, { force: true });
	await fs.rm(path.slice(0, -".jsonl".length), { recursive: true, force: true });
	sessionCache.delete(path);
}

export async function sessionDirectoriesForWorkspace(
	cwd: string,
	options: SessionSearchOptions = {},
): Promise<string[]> {
	return (await sessionSearch(cwd, options)).directories;
}

async function sessionSearch(cwd: string, options: SessionSearchOptions): Promise<{ cwd: string; directories: string[] }> {
	const workspaceCwd = await fs.realpath(cwd).catch(() => resolve(cwd));
	const env = options.env ?? process.env;
	const agentDir = expandHome(options.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	const configuredSessionDir = options.sessionDir ?? env.PI_CODING_AGENT_SESSION_DIR;
	const directories = configuredSessionDir
		? [expandHome(configuredSessionDir)]
		: [
				join(agentDir, "sessions", encodeWorkspaceDirectory(workspaceCwd)),
				join(agentDir, "session", encodeWorkspaceDirectory(workspaceCwd)),
			];
	return { cwd: workspaceCwd, directories };
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return resolve(value);
}

async function readSessions(directory: string, cwd: string): Promise<PiSession[]> {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const paths = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(directory, entry.name));
		return readSessionsWithConcurrency(paths, cwd);
	} catch {
		return [];
	}
}

async function readSessionsWithConcurrency(paths: string[], cwd: string): Promise<PiSession[]> {
	const sessions: PiSession[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < paths.length) {
			const path = paths[next++];
			if (!path) continue;
			try {
				const session = await readSession(path, cwd);
				if (session) sessions.push(session);
			} catch {
				// A session may be deleted or still being written while we scan it.
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(paths.length, MAX_CONCURRENT_SESSION_READS) }, worker));
	return sessions;
}

async function readSession(path: string, cwd: string): Promise<PiSession | undefined> {
	const stat = await fs.stat(path);
	const cached = sessionCache.get(path);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return samePath(cached.cwd, cwd) ? cached : undefined;
	}

	const parsed = await parseSession(path);
	if (!parsed || !samePath(parsed.cwd, cwd)) return undefined;
	const session: CachedSession = {
		id: parsed.id,
		path,
		title: parsed.title,
		cwd: parsed.cwd,
		createdAtMs: sessionCreatedAt(parsed.header, stat.birthtimeMs || stat.mtimeMs),
		mtimeMs: stat.mtimeMs,
		size: stat.size,
	};
	sessionCache.set(path, session);
	return session;
}

async function parseSession(path: string): Promise<{ header: SessionHeader; id: string; cwd: string; title: string } | undefined> {
	let header: SessionHeader | undefined;
	let sessionInfoName: string | undefined;
	let firstUserText: string | undefined;
	const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of lines) {
		const entry = parseLine(line);
		if (!entry) continue;
		if (!header) {
			if (entry.type !== "session" || typeof entry.id !== "string" || typeof entry.cwd !== "string") return undefined;
			header = entry;
			continue;
		}
		if (entry.type === "session_info") sessionInfoName = sessionTitle(entry.name) ?? sessionInfoName;
		if (!firstUserText && entry.type === "message" && isUserMessage(entry.message)) {
			const text = extractUserMessageText(entry.message.content);
			if (text.trim()) firstUserText = text;
		}
	}
	if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") return undefined;
	return { header, id: header.id, cwd: header.cwd, title: sessionInfoName ?? (firstUserText ? deriveTitle(firstUserText) : NEW_SESSION_TITLE) };
}

function parseLine(line: string): Record<string, unknown> | undefined {
	if (!line.trim()) return undefined;
	try {
		const entry = JSON.parse(line) as unknown;
		return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function sessionTitle(name: unknown): string | undefined {
	return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function isUserMessage(message: unknown): message is { role: unknown; content: unknown } {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "user";
}

function extractUserMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function deriveTitle(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
}

function sessionCreatedAt(header: SessionHeader, fallback: number): number {
	const timestamp = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
	return Number.isFinite(timestamp) ? timestamp : fallback;
}

function samePath(a: string, b: string): boolean {
	const left = resolve(a);
	const right = resolve(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
