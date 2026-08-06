import assert from "node:assert/strict";
import test from "node:test";

const { nativeInputKey } = require("../../media/ime.js") as {
	nativeInputKey(event: Record<string, unknown>): boolean;
};

function key(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "keydown",
		code: "Comma",
		key: ",",
		keyCode: 188,
		isComposing: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		...overrides,
	};
}

test("unmodified punctuation and digits use native text input, shifted forms included", () => {
	assert.equal(nativeInputKey(key()), true);
	assert.equal(nativeInputKey(key({ code: "Period", key: "." })), true);
	assert.equal(nativeInputKey(key({ code: "Digit1", key: "1" })), true);
	assert.equal(nativeInputKey(key({ key: "<", shiftKey: true })), true); // 《
});

test("modifier combos stay shortcuts", () => {
	assert.equal(nativeInputKey(key({ ctrlKey: true })), false);
	assert.equal(nativeInputKey(key({ metaKey: true })), false);
	assert.equal(nativeInputKey(key({ altKey: true })), false);
});

test("keys already claimed by an IME keep xterm's built-in path", () => {
	// Pinyin candidate selection presses digits mid-composition.
	assert.equal(nativeInputKey(key({ isComposing: true })), false);
	// Apple拼音 marks IME-consumed keys keyCode 229.
	assert.equal(nativeInputKey(key({ keyCode: 229 })), false);
});

test("other keys and event types are untouched", () => {
	assert.equal(nativeInputKey(key({ code: "KeyA", key: "a" })), false);
	assert.equal(nativeInputKey(key({ code: "Enter", key: "Enter" })), false);
	assert.equal(nativeInputKey(key({ type: "keypress" })), false);
});
