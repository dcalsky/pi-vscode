import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { appendFile, mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	deleteSessionFiles,
	encodeWorkspaceDirectory,
	listWorkspaceSessions,
	NEW_SESSION_TITLE,
} from "../session-store";

test("lists only this workspace's sessions, newest first", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	await mkdir(sessionsDir, { recursive: true });

	const older = join(sessionsDir, "old.jsonl");
	const newer = join(sessionsDir, "new.jsonl");
	const wrongWorkspace = join(sessionsDir, "wrong.jsonl");
	const oldCreatedAt = "2026-01-01T00:00:00.000Z";
	const newCreatedAt = "2026-07-01T00:00:00.000Z";
	await writeFile(older, sessionHeader("old", workspace, oldCreatedAt));
	await writeFile(newer, sessionHeader("new", workspace, newCreatedAt));
	await writeFile(wrongWorkspace, sessionHeader("wrong", join(root, "elsewhere")));
	const now = Date.now() / 1000;
	await utimes(older, now - 2, now - 2);
	await utimes(newer, now, now);

	const sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
	assert.deepEqual(
		sessions.map((session) => session.id),
		["new", "old"],
	);
	assert.equal(sessions[0].createdAtMs, Date.parse(newCreatedAt));
});


test("derives titles from first eligible user messages", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(
		join(sessionsDir, "derived.jsonl"),
		sessionHeader("derived", workspace) + userMessage("Find terminal replay bug") + userMessage("This later request must not win"),
	);

	const [session] = await listWorkspaceSessions(workspace, { agentDir, env: {} });
	assert.equal(session?.title, "Find terminal replay bug");
});

test("derives titles from string and text-part message content", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(join(sessionsDir, "string.jsonl"), sessionHeader("string", workspace) + userMessage("String content", "String content"));
	await writeFile(
		join(sessionsDir, "parts.jsonl"),
		sessionHeader("parts", workspace) + userMessage("", [{ type: "thinking", text: "skip" }, { type: "text", text: "First" }, { type: "text", text: " second" }]),
	);

	const titles = (await listWorkspaceSessions(workspace, { agentDir, env: {} })).map((session) => session.title);
	assert.deepEqual(titles.sort(), ["First second", "String content"]);
});

test("skips ineligible user messages and keeps placeholder without an eligible message", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(
		join(sessionsDir, "skips.jsonl"),
		sessionHeader("skips", workspace) + userMessage("   ") + userMessage("", [{ type: "image", url: "ignored" }]) + userMessage("Eligible title"),
	);
	await writeFile(join(sessionsDir, "empty.jsonl"), sessionHeader("empty", workspace) + userMessage("\t") + userMessage("", [{ type: "image" }]));

	const titles = new Map((await listWorkspaceSessions(workspace, { agentDir, env: {} })).map((session) => [session.id, session.title]));
	assert.equal(titles.get("skips"), "Eligible title");
	assert.equal(titles.get("empty"), NEW_SESSION_TITLE);
});

test("cleans and bounds derived titles", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(join(sessionsDir, "clean.jsonl"), sessionHeader("clean", workspace) + userMessage(" first\n\tsecond   third "));
	await writeFile(join(sessionsDir, "long.jsonl"), sessionHeader("long", workspace) + userMessage("x".repeat(61)));

	const titles = new Map((await listWorkspaceSessions(workspace, { agentDir, env: {} })).map((session) => [session.id, session.title]));
	assert.equal(titles.get("clean"), "first second third");
	assert.equal(titles.get("long"), `${"x".repeat(60)}…`);
});

test("uses explicit names over derived titles and ignores invalid names", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(
		join(sessionsDir, "named-first.jsonl"),
		sessionHeader("named-first", workspace) + sessionInfo("Explicit first") + userMessage("Derived second"),
	);
	await writeFile(
		join(sessionsDir, "named-last.jsonl"),
		sessionHeader("named-last", workspace) + userMessage("Derived first") + sessionInfo("Explicit last"),
	);
	await writeFile(
		join(sessionsDir, "invalid.jsonl"),
		sessionHeader("invalid", workspace) + userMessage("Fallback title") + sessionInfo("   ") + `${JSON.stringify({ type: "session_info", name: 42 })}\n`,
	);

	const titles = new Map((await listWorkspaceSessions(workspace, { agentDir, env: {} })).map((session) => [session.id, session.title]));
	assert.equal(titles.get("named-first"), "Explicit first");
	assert.equal(titles.get("named-last"), "Explicit last");
	assert.equal(titles.get("invalid"), "Fallback title");
});

test("uses the latest session_info name and notices appended updates", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	const sessionPath = join(sessionsDir, "named.jsonl");
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(sessionPath, sessionHeader("named", workspace) + userMessage("Derived title"));

	let sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
	assert.equal(sessions[0]?.title, "Derived title");

	await appendFile(sessionPath, `${JSON.stringify({ type: "session_info", name: "First name" })}\n`);
	sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
	assert.equal(sessions[0]?.title, "First name");

	await appendFile(sessionPath, `${JSON.stringify({ type: "session_info", name: "Renamed" })}\n`);
	sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
	assert.equal(sessions[0]?.title, "Renamed");
});


test("updates a cached session title after its first user message is appended", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	const sessionPath = join(sessionsDir, "live.jsonl");
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(sessionPath, sessionHeader("live", workspace));
	assert.equal((await listWorkspaceSessions(workspace, { agentDir, env: {} }))[0]?.title, NEW_SESSION_TITLE);

	await appendFile(sessionPath, userMessage("Live session title"));
	assert.equal((await listWorkspaceSessions(workspace, { agentDir, env: {} }))[0]?.title, "Live session title");
});

test("keeps session title derivation read-only and within title invariants", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	const sessionPath = join(sessionsDir, "named.jsonl");
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(sessionPath, sessionHeader("named", workspace) + userMessage("first\n\tsecond") + sessionInfo("Named session"));
	await writeFile(join(sessionsDir, "derived.jsonl"), sessionHeader("derived", workspace) + userMessage(`${"x".repeat(60)}\n\tsecond`));
	await writeFile(join(sessionsDir, "empty.jsonl"), sessionHeader("empty", workspace));
	const before = await stat(sessionPath);

	const sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
	const after = await stat(sessionPath);
	assert.equal(after.mtimeMs, before.mtimeMs);
	assert.deepEqual(new Map(sessions.map((session) => [session.id, session.title])), new Map([
		["named", "Named session"],
		["derived", `${"x".repeat(60)}…`],
		["empty", NEW_SESSION_TITLE],
	]));
	for (const session of sessions) assert.ok(session.title.length > 0);
	const derived = sessions.find((session) => session.id === "derived");
	assert.ok(derived);
	assert.ok(derived.title.length <= 61);
	assert.doesNotMatch(derived.title, /\s{2,}|[\r\n\t]/);
});

test("finds sessions when the workspace is opened through a symlink", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const workspaceLink = join(root, "project-link");
	const agentDir = join(root, "agent");
	await mkdir(workspace);
	await symlink(workspace, workspaceLink, process.platform === "win32" ? "junction" : "dir");
	const realWorkspace = await realpath(workspace);
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(realWorkspace));
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(join(sessionsDir, "session.jsonl"), sessionHeader("linked", realWorkspace));

	const sessions = await listWorkspaceSessions(workspaceLink, { agentDir, env: {} });
	assert.deepEqual(
		sessions.map((session) => session.id),
		["linked"],
	);
});

test("deleting a session removes its transcript and sidecar directory only", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	const doomed = join(sessionsDir, "doomed.jsonl");
	await mkdir(join(sessionsDir, "doomed", "state"), { recursive: true });
	await writeFile(join(sessionsDir, "doomed", "state", "notes.json"), "{}");
	await writeFile(doomed, sessionHeader("doomed", workspace));
	await writeFile(join(sessionsDir, "keep.jsonl"), sessionHeader("keep", workspace));
	assert.equal((await listWorkspaceSessions(workspace, { agentDir, env: {} })).length, 2);

	await deleteSessionFiles(doomed);

	assert.deepEqual(
		(await listWorkspaceSessions(workspace, { agentDir, env: {} })).map((session) => session.id),
		["keep"],
	);
	assert.equal(existsSync(join(sessionsDir, "doomed")), false);
	await deleteSessionFiles(doomed);
	await assert.rejects(deleteSessionFiles(sessionsDir), /Not a session transcript/);
	assert.equal(existsSync(sessionsDir), true);
});

function sessionHeader(id: string, cwd: string, timestamp?: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd })}\n`;
}

function sessionInfo(name: unknown): string {
	return `${JSON.stringify({ type: "session_info", name })}\n`;
}

function userMessage(text: string, content: unknown = [{ type: "text", text }]): string {
	return `${JSON.stringify({ type: "message", message: { role: "user", content } })}\n`;
}
