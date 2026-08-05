import assert from "node:assert/strict";
import test from "node:test";

interface PiClipboard {
	clipboardAction(event: Record<string, unknown>, hasSelection: boolean, isMac?: boolean): string | null;
}

const { clipboardAction } = require("../../media/clipboard.js") as PiClipboard;

function key(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "keydown", key: "v", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides };
}

test("Cmd+V pastes on mac, with or without Shift", () => {
	assert.equal(clipboardAction(key({ metaKey: true }), false, true), "paste");
	assert.equal(clipboardAction(key({ metaKey: true, shiftKey: true }), false, true), "paste");
});

test("Cmd+C on mac copies only with a selection and never sends ^C", () => {
	assert.equal(clipboardAction(key({ key: "c", metaKey: true }), true, true), "copy");
	assert.equal(clipboardAction(key({ key: "c", metaKey: true }), false, true), null);
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true }), false, true), null);
});

test("Ctrl+C on win/linux copies with a selection, falls through without one", () => {
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true }), true, false), "copy");
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true }), false, false), null);
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true, shiftKey: true }), true, false), "copy");
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true, shiftKey: true }), false, false), null);
});

test("Ctrl+V and Shift+Insert paste on win/linux", () => {
	assert.equal(clipboardAction(key({ ctrlKey: true }), false, false), "paste");
	assert.equal(clipboardAction(key({ ctrlKey: true, shiftKey: true }), false, false), "paste");
	assert.equal(clipboardAction(key({ key: "Insert", shiftKey: true }), false, false), "paste");
});

test("Modifier combinations that must stay untouched", () => {
	assert.equal(clipboardAction(key({ altKey: true, metaKey: true }), false, true), null);
	assert.equal(clipboardAction(key({ key: "c" }), true, true), null);
	assert.equal(clipboardAction(key({ key: "x", metaKey: true }), false, true), null);
	assert.equal(clipboardAction({ ...key({ metaKey: true }), type: "keyup" }, false, true), null);
});
