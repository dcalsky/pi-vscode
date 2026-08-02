import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RESTORED_SESSIONS, normalizeViewState, setArchived } from "../view-state";

test("treats unusable persisted state as empty", () => {
	assert.deepEqual(normalizeViewState(undefined), { openSessions: [], archivedSessionIds: [] });
	assert.deepEqual(normalizeViewState("nope"), { openSessions: [], archivedSessionIds: [] });
	assert.deepEqual(normalizeViewState({ openSessions: "a", archivedSessionIds: 3 }), {
		openSessions: [],
		archivedSessionIds: [],
	});
});

test("keeps only usable open sessions and caps how many are restored", () => {
	const state = normalizeViewState({
		openSessions: [
			{ id: "a", path: "/tmp/a.jsonl" },
			{ id: "b" },
			{ id: "a", path: "/tmp/duplicate.jsonl" },
			{ id: "  ", path: "/tmp/blank.jsonl" },
			{ id: "c", path: 7 },
			"nope",
			...Array.from({ length: MAX_RESTORED_SESSIONS }, (_, index) => ({ id: `extra-${index}` })),
		],
	});

	assert.deepEqual(state.openSessions.slice(0, 3), [{ id: "a", path: "/tmp/a.jsonl" }, { id: "b" }, { id: "c" }]);
	assert.equal(state.openSessions.length, MAX_RESTORED_SESSIONS);
});

test("never restores an archived session and keeps focus only on a restored session", () => {
	const archivedFocus = normalizeViewState({
		openSessions: [{ id: "a" }, { id: "archived" }],
		archivedSessionIds: ["archived", "archived", ""],
		focusedSessionId: "archived",
	});
	assert.deepEqual(archivedFocus.openSessions, [{ id: "a" }]);
	assert.deepEqual(archivedFocus.archivedSessionIds, ["archived"]);
	assert.equal(archivedFocus.focusedSessionId, undefined);

	const keptFocus = normalizeViewState({ openSessions: [{ id: "a" }, { id: "b" }], focusedSessionId: "b" });
	assert.equal(keptFocus.focusedSessionId, "b");
});

test("archiving a session drops it from the restored tabs and from focus", () => {
	const state = normalizeViewState({
		openSessions: [{ id: "a" }, { id: "b", path: "/tmp/b.jsonl" }],
		focusedSessionId: "b",
	});

	const archived = setArchived(state, "b", true);
	assert.deepEqual(archived.archivedSessionIds, ["b"]);
	assert.deepEqual(archived.openSessions, [{ id: "a" }]);
	assert.equal(archived.focusedSessionId, undefined);

	const restored = setArchived(archived, "b", false);
	assert.deepEqual(restored.archivedSessionIds, []);
	assert.deepEqual(restored.openSessions, [{ id: "a" }]);
});

test("ignores archive requests without a session id", () => {
	const state = normalizeViewState({ openSessions: [{ id: "a" }] });
	assert.equal(setArchived(state, "", true), state);
	assert.equal(setArchived(state, "   ", true), state);
});
