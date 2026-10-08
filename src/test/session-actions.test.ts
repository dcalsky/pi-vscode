import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	appendSessionName,
	createForkedSession,
	listSessionUserMessages,
	prepareRewindSession,
	resolveSessionSnapshot,
	restoreWorktreeSnapshot,
	worktreeDiffersFromSnapshot,
} from "../session-actions";

test("lists user messages from the current branch", async (t) => {
	const fixture = await sessionFixture(t);
	assert.deepEqual(await listSessionUserMessages(fixture.path), [
		{ id: "user-1", text: "First prompt" },
		{ id: "user-2", text: "Second prompt" },
	]);

	assert.deepEqual(await listSessionUserMessages(fixture.path, "abandoned-assistant"), [
		{ id: "user-1", text: "First prompt" },
		{ id: "abandoned-user", text: "Abandoned prompt" },
	]);
});

test("renames a saved session the way Pi's /name does", async (t) => {
	const fixture = await sessionFixture(t);
	await appendSessionName(fixture.path, "  Renamed\nsession  ");

	const records = await readRecords(fixture.path);
	const entry = records.at(-1);
	assert.equal(entry?.type, "session_info");
	assert.equal(entry?.name, "Renamed session");
	assert.equal(entry?.parentId, "title");
	assert.match(String(entry?.id), /^[0-9a-f]{8}$/);
	await assert.rejects(appendSessionName(fixture.path, " \n "), /cannot be empty/);
});

test("forks before the selected message and leaves that message as a draft", async (t) => {
	const fixture = await sessionFixture(t);
	const first = await createForkedSession(fixture.path, "user-2", "Source title");
	const second = await createForkedSession(fixture.path, "user-2", "Source title");

	assert.equal(first.title, "(1) Source title");
	assert.equal(second.title, "(2) Source title");
	assert.equal(first.draft, "Second prompt");
	assert.notEqual(first.id, "source-session");
	const records = await readRecords(first.path);
	assert.equal(records[0]?.id, first.id);
	assert.equal(records[0]?.parentSession, resolve(fixture.path));
	assert.deepEqual(records.slice(1, -1).map((entry) => entry.id), ["model", "user-1", "assistant-1"]);
	assert.equal(records.some((entry) => entry.id === "user-2"), false);
	assert.deepEqual(records.slice(1).map((entry) => entry.parentId), [null, "model", "user-1", "assistant-1"]);
	assert.equal(records.at(-1)?.name, "(1) Source title");
});

test("forks the whole session when no message is selected", async (t) => {
	const fixture = await sessionFixture(t);
	const forked = await createForkedSession(fixture.path, undefined, "Source title");

	assert.equal(forked.draft, "");
	const records = await readRecords(forked.path);
	assert.equal(records[0]?.id, forked.id);
	assert.equal(records[0]?.parentSession, resolve(fixture.path));
	assert.deepEqual(records.slice(1, -1).map((entry) => entry.id), [
		"model",
		"user-1",
		"assistant-1",
		"user-2",
		"assistant-2",
	]);
	assert.deepEqual(records.slice(1).map((entry) => entry.parentId), [null, "model", "user-1", "assistant-1", "user-2", "assistant-2"]);
	assert.equal(records.at(-1)?.name, "(1) Source title");
});

test("prepares an in-place rewind with the same session id", async (t) => {
	const fixture = await sessionFixture(t);
	const rewind = await prepareRewindSession(fixture.path, "user-2", "Source title");
	const records = rewind.contents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

	assert.equal(rewind.draft, "Second prompt");
	assert.equal(records[0]?.id, "source-session");
	assert.deepEqual(records.slice(1, -1).map((entry) => entry.id), ["model", "user-1", "assistant-1"]);
	assert.equal(records.some((entry) => entry.id === "user-2"), false);
	assert.equal(records.at(-1)?.name, "Source title");
});

test("resolves pi-rewind-hook and native checkpoints through session lineage", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-actions-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const parent = join(root, "parent.jsonl");
	const child = join(root, "child.jsonl");
	const hookSnapshot = "1".repeat(40);
	const nativeSnapshot = "2".repeat(40);
	await writeFile(
		parent,
		jsonl(
			{ type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: root },
			{ type: "custom", id: "hook", parentId: null, customType: "rewind-turn", data: { v: 2, snapshots: [hookSnapshot], bindings: [["user-1", 0]] } },
		),
	);
	await writeFile(
		child,
		jsonl(
			{ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: root, parentSession: parent },
			{ type: "custom", id: "native", parentId: null, customType: "pi-vscode-rewind", data: { v: 1, entryId: "user-2", commit: nativeSnapshot } },
		),
	);

	assert.equal(await resolveSessionSnapshot(child, "user-1"), hookSnapshot);
	assert.equal(await resolveSessionSnapshot(child, "user-2"), nativeSnapshot);
	assert.equal(await resolveSessionSnapshot(child, "missing"), undefined);
});

test("detects and exactly restores worktree changes without changing the real index", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-git-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, ["init"]);
	await git(root, ["config", "user.name", "Pi VS Code Test"]);
	await git(root, ["config", "user.email", "pi-vscode@example.com"]);
	// Git for Windows installs core.autocrlf=true system-wide, which would rewrite
	// these fixtures' line endings on checkout and defeat the byte-exact assertions.
	await git(root, ["config", "core.autocrlf", "false"]);
	await writeFile(join(root, "keep.txt"), "before\n");
	await writeFile(join(root, "revive.txt"), "restore me\n");
	await git(root, ["add", "-A"]);
	await git(root, ["commit", "-m", "target"]);
	const snapshot = (await git(root, ["rev-parse", "HEAD"])).trim();

	await writeFile(join(root, "keep.txt"), "after\n");
	await git(root, ["add", "keep.txt"]);
	await rm(join(root, "revive.txt"));
	await writeFile(join(root, "new.txt"), "remove me\n");
	const cachedBefore = await git(root, ["diff", "--cached", "--", "keep.txt"]);

	assert.equal(await worktreeDiffersFromSnapshot(root, snapshot), true);
	assert.equal(await restoreWorktreeSnapshot(root, snapshot), true);
	assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "before\n");
	assert.equal(await readFile(join(root, "revive.txt"), "utf8"), "restore me\n");
	await assert.rejects(readFile(join(root, "new.txt"), "utf8"), { code: "ENOENT" });
	assert.equal(await git(root, ["diff", "--cached", "--", "keep.txt"]), cachedBefore);
	assert.equal(await worktreeDiffersFromSnapshot(root, snapshot), false);
});

async function sessionFixture(t: test.TestContext): Promise<{ path: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-vscode-actions-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(root, { recursive: true });
	const path = join(root, "source.jsonl");
	await writeFile(
		path,
		jsonl(
			{ type: "session", version: 3, id: "source-session", timestamp: new Date().toISOString(), cwd: root },
			{ type: "model_change", id: "model", parentId: null },
			user("user-1", "model", "First prompt"),
			{ type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant", content: [{ type: "text", text: "First answer" }] } },
			user("abandoned-user", "assistant-1", "Abandoned prompt"),
			{ type: "message", id: "abandoned-assistant", parentId: "abandoned-user", message: { role: "assistant", content: [] } },
			user("user-2", "assistant-1", "Second prompt"),
			{ type: "message", id: "assistant-2", parentId: "user-2", message: { role: "assistant", content: [] } },
			{ type: "session_info", id: "title", parentId: "assistant-2", name: "Source title" },
		),
	);
	return { path };
}

function user(id: string, parentId: string | null, text: string): Record<string, unknown> {
	return { type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] } };
}

function jsonl(...records: Record<string, unknown>[]): string {
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function readRecords(path: string): Promise<Record<string, unknown>[]> {
	return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(String(stderr).trim() || error.message));
				return;
			}
			resolvePromise(String(stdout));
		});
	});
}
