import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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


test("uses the latest session_info name and notices appended updates", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const workspace = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
	const sessionPath = join(sessionsDir, "named.jsonl");
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(sessionPath, sessionHeader("named", workspace));

	let sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
	assert.equal(sessions[0]?.title, NEW_SESSION_TITLE);

	await appendFile(sessionPath, `${JSON.stringify({ type: "session_info", name: "First name" })}\n`);
	sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
	assert.equal(sessions[0]?.title, "First name");

	await appendFile(sessionPath, `${JSON.stringify({ type: "session_info", name: "Renamed" })}\n`);
	sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
	assert.equal(sessions[0]?.title, "Renamed");
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
