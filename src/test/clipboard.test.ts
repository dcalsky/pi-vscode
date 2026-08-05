import assert from "node:assert/strict";
import test from "node:test";

interface PiClipboard {
	clipboardAction(
		event: Record<string, unknown>,
		hasSelection: boolean,
		context?: { isMac?: boolean; isLinux?: boolean; input?: boolean },
	): string | null;
	arrowAction(event: Record<string, unknown>, isMac?: boolean): string | null;
}

const { clipboardAction, arrowAction } = require("../../media/clipboard.js") as PiClipboard;

function key(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "keydown", key: "v", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides };
}

test("macOS: Cmd+V pastes, Cmd+Shift+V does nothing", () => {
	assert.equal(clipboardAction(key({ metaKey: true }), false, { isMac: true }), "paste");
	assert.equal(clipboardAction(key({ metaKey: true, shiftKey: true }), false, { isMac: true }), null);
});

test("macOS: only plain Cmd+C copies with a selection and never sends ^C", () => {
	assert.equal(clipboardAction(key({ key: "c", metaKey: true }), true, { isMac: true }), "copy");
	assert.equal(clipboardAction(key({ key: "c", metaKey: true }), false, { isMac: true }), null);
	assert.equal(clipboardAction(key({ key: "c", metaKey: true, shiftKey: true }), true, { isMac: true }), null);
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true }), true, { isMac: true }), null);
});

test("Windows: Ctrl+C copies and clears with a selection, falls through without one", () => {
	const win = { isMac: false, isLinux: false };
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true }), true, win), "copyAndClear");
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true }), false, win), null);
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true, shiftKey: true }), true, win), "copy");
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true, shiftKey: true }), false, win), null);
});

test("Windows: Ctrl+V and Ctrl+Shift+V paste", () => {
	const win = { isMac: false, isLinux: false };
	assert.equal(clipboardAction(key({ ctrlKey: true }), false, win), "paste");
	assert.equal(clipboardAction(key({ ctrlKey: true, shiftKey: true }), false, win), "paste");
});

test("Linux: only Ctrl+Shift+C copies and Ctrl+Shift+V pastes; plain Ctrl+C/V reach the shell", () => {
	const linux = { isMac: false, isLinux: true };
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true, shiftKey: true }), true, linux), "copy");
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true, shiftKey: true }), false, linux), null);
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true }), true, linux), null);
	assert.equal(clipboardAction(key({ ctrlKey: true, shiftKey: true }), false, linux), "paste");
	assert.equal(clipboardAction(key({ ctrlKey: true }), false, linux), null);
});

test("Inputs keep the browser convention on every platform", () => {
	const linux = { isMac: false, isLinux: true, input: true };
	assert.equal(clipboardAction(key({ ctrlKey: true }), false, linux), "paste");
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true }), true, linux), "copy");
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true }), true, { isMac: false, input: true }), "copy");
	assert.equal(clipboardAction(key({ key: "c", ctrlKey: true }), false, { input: true }), null);
});

test("macOS: Cmd+Left/Right send ^A/^E", () => {
	assert.equal(arrowAction(key({ key: "ArrowLeft", metaKey: true }), true), "\x01");
	assert.equal(arrowAction(key({ key: "ArrowRight", metaKey: true }), true), "\x05");
});

test("arrowAction: other platforms and modifier combos do nothing", () => {
	assert.equal(arrowAction(key({ key: "ArrowLeft", metaKey: true }), false), null);
	assert.equal(arrowAction(key({ key: "ArrowLeft" }), true), null);
	assert.equal(arrowAction(key({ key: "ArrowLeft", metaKey: true, ctrlKey: true }), true), null);
	assert.equal(arrowAction(key({ key: "ArrowLeft", metaKey: true, altKey: true }), true), null);
	assert.equal(arrowAction({ ...key({ key: "ArrowLeft", metaKey: true }), type: "keyup" }, true), null);
});

test("Modifier combinations that must stay untouched", () => {
	const win = { isMac: false, isLinux: false };
	assert.equal(clipboardAction(key({ altKey: true, metaKey: true }), false, { isMac: true }), null);
	assert.equal(clipboardAction(key({ key: "c" }), true, win), null);
	assert.equal(clipboardAction(key({ key: "x", metaKey: true }), false, { isMac: true }), null);
	assert.equal(clipboardAction(key({ key: "Insert", shiftKey: true }), false, win), null);
	assert.equal(clipboardAction({ ...key({ metaKey: true }), type: "keyup" }, false, { isMac: true }), null);
});
