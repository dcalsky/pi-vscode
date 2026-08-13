import assert from "node:assert/strict";
import test from "node:test";
import { Terminal } from "@xterm/headless";
import { TerminalReplay } from "../terminal-replay";

test("serializes a PTY screen and exposes an exact output watermark", async () => {
	const replay = new TerminalReplay(20, 4, 10);
	assert.equal(replay.write("first\r\n\x1b[31msecond\x1b[0m"), 1);
	assert.equal(replay.write("\r\nthird\x1b[2;4H!"), 2);

	const snapshot = await replay.snapshot();
	assert.equal(snapshot.sequence, 2);

	const restored = new Terminal({ cols: 20, rows: 4, scrollback: 10 });
	await write(restored, snapshot.data);
	assert.equal(restored.buffer.active.getLine(0)?.translateToString(true), "first");
	assert.equal(restored.buffer.active.getLine(1)?.translateToString(true), "sec!nd");
	assert.equal(restored.buffer.active.getLine(2)?.translateToString(true), "third");
	assert.equal(restored.buffer.active.cursorX, 4);
	assert.equal(restored.buffer.active.cursorY, 1);

	restored.dispose();
	replay.dispose();
});

test("snapshot waits for writes queued while xterm is parsing", async () => {
	const replay = new TerminalReplay(12, 3, 3);
	for (let index = 0; index < 20; index++) replay.write(`${index}\r\n`);
	const snapshot = await replay.snapshot();
	assert.equal(snapshot.sequence, 20);
	assert.ok(snapshot.data.includes("19"));
	replay.dispose();
});

test("replays Kitty keyboard mode that addon-serialize does not preserve", async () => {
	const replay = new TerminalReplay();
	replay.write("\x1b[>7");
	replay.write("uhello");
	const snapshot = await replay.snapshot();
	assert.ok(snapshot.data.startsWith("\x1b[>7u"));
	replay.dispose();
});

test("maps every hard-wrapped path fragment back to the complete native terminal link", async () => {
	const replay = new TerminalReplay(24, 5, 10);
	const target = "/workspace/docs/architecture/native-terminal.md";
	const width = 22;
	const rows = [];
	for (let offset = 0; offset < target.length; offset += width) rows.push(` ${target.slice(offset, offset + width)} `);
	replay.write(rows.join("\r\n"));

	for (let index = 0; index < rows.length; index++) {
		assert.deepEqual(await replay.linksForLine(rows[index]), [
			{ startIndex: 1, length: Math.min(width, target.length - index * width), target, kind: "file" },
		]);
	}
	replay.dispose();
});

function write(terminal: Terminal, data: string): Promise<void> {
	return new Promise((resolve) => terminal.write(data, resolve));
}
