import assert from "node:assert/strict";
import test from "node:test";
import { terminalOptions, type ConfigReader } from "../xterm-options";

function reader(values: Record<string, Record<string, unknown>>): ConfigReader {
	return (section) => ({
		get: <T,>(key: string, fallback: T) => (values[section]?.[key] as T) ?? fallback,
	});
}

test("mirrors VS Code defaults when nothing is configured", () => {
	const options = terminalOptions(reader({}));
	assert.equal(options.xterm.fontSize, 12);
	assert.equal(options.xterm.cursorStyle, "block");
	assert.equal(options.xterm.smoothScrollDuration, 0);
	assert.equal(options.xterm.minimumContrastRatio, 4.5);
	assert.deepEqual(options.xterm.vtExtensions, { kittyKeyboard: true });
	assert.equal(options.gpuAcceleration, "auto");
});

test("maps terminal settings onto xterm option names", () => {
	const options = terminalOptions(
		reader({
			"terminal.integrated": {
				fontSize: 15,
				lineHeight: 1.2,
				cursorStyle: "line",
				cursorStyleInactive: "underline",
				smoothScrolling: true,
				rightClickBehavior: "copyPaste",
				scrollback: 5000,
				copyOnSelection: true,
				enableKittyKeyboardProtocol: false,
				gpuAcceleration: "off",
			},
			editor: { mouseWheelScrollSensitivity: 2 },
		}),
	);
	assert.equal(options.xterm.fontSize, 15);
	assert.equal(options.xterm.lineHeight, 1.2);
	assert.equal(options.xterm.cursorStyle, "bar");
	assert.equal(options.xterm.cursorInactiveStyle, "underline");
	assert.equal(options.xterm.smoothScrollDuration, 125);
	assert.equal(options.xterm.rightClickSelectsWord, false);
	assert.equal(options.xterm.scrollback, 5000);
	assert.equal(options.xterm.scrollSensitivity, 2);
	assert.deepEqual(options.xterm.vtExtensions, { kittyKeyboard: false });
	assert.equal(options.copyOnSelection, true);
	assert.equal(options.kittyKeyboard, false);
	assert.equal(options.gpuAcceleration, "off");
});

test("falls back to the editor font and clamps out-of-range values", () => {
	const options = terminalOptions(
		reader({
			"terminal.integrated": { fontFamily: "  ", fontSize: 400, lineHeight: 0 },
			editor: { fontFamily: "Fira Code" },
		}),
	);
	assert.equal(options.xterm.fontFamily, "Fira Code");
	assert.equal(options.xterm.fontSize, 100);
	assert.equal(options.xterm.lineHeight, 1);
});

test("alt-click follows the editor's multi-cursor modifier", () => {
	const withCtrl = terminalOptions(reader({ editor: { multiCursorModifier: "ctrlCmd" } }));
	assert.equal(withCtrl.xterm.altClickMovesCursor, false);
	const withAlt = terminalOptions(reader({ editor: { multiCursorModifier: "alt" } }));
	assert.equal(withAlt.xterm.altClickMovesCursor, true);
});
