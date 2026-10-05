import assert from "node:assert/strict";
import test from "node:test";
import { cmdCommandLine, cmdQuote, piTuiModeArgs, win32Spawn } from "../pi-command";

test("cmdQuote leaves plain args untouched", () => {
	assert.equal(cmdQuote("pi"), "pi");
	assert.equal(cmdQuote("--session-id"), "--session-id");
});

test("cmdQuote wraps args with spaces or quotes", () => {
	assert.equal(cmdQuote("C:\\path with spaces\\pi.cmd"), '"C:\\path with spaces\\pi.cmd"');
	assert.equal(cmdQuote('say "hi"'), '"say \\"hi\\""');
});

test("cmdCommandLine joins file and args with quoting", () => {
	assert.equal(
		cmdCommandLine("C:\\Users\\me\\npm\\pi.cmd", ["--session", "C:\\my project\\session.json"]),
		'C:\\Users\\me\\npm\\pi.cmd --session "C:\\my project\\session.json"',
	);
});

test("win32Spawn wraps non-exe commands in cmd.exe /d /s /c", () => {
	const { file, args } = win32Spawn("pi", ["--session-id", "abc"]);
	assert.equal(file, "cmd.exe");
	assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
	assert.equal(args[3], "pi --session-id abc");
});

test("win32Spawn wraps npm's .cmd shim path", () => {
	const { file, args } = win32Spawn("C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd", ["--session-id", "abc"]);
	assert.equal(file, "cmd.exe");
	assert.equal(args[3], 'C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd --session-id abc');
});

test("win32Spawn spawns real .exe paths directly", () => {
	const { file, args } = win32Spawn("C:\\tools\\pi.exe", ["--session-id", "abc"]);
	assert.equal(file, "C:\\tools\\pi.exe");
	assert.deepEqual(args, ["--session-id", "abc"]);
});

test("piTuiModeArgs forces regular mode unless the user inherits Pi's setting", () => {
	assert.deepEqual(piTuiModeArgs(undefined, true), ["--tui-mode", "regular"]);
	assert.deepEqual(piTuiModeArgs("regular", true), ["--tui-mode", "regular"]);
	assert.deepEqual(piTuiModeArgs("inherit", true), []);
});

test("piTuiModeArgs omits the flag when older Pi could not accept it", () => {
	assert.deepEqual(piTuiModeArgs("regular", false), []);
});
