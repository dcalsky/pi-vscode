import assert from "node:assert/strict";
import test from "node:test";
import { Terminal } from "@xterm/xterm";

interface IBufferRange {
	start: { x: number; y: number };
	end: { x: number; y: number };
}

interface WrappedPathLinks {
	copySelectionText(terminal: Terminal, position: IBufferRange): string | undefined;
}

const wrappedPathLinks = require("../../media/wrapped-path-links.js") as WrappedPathLinks;

test("copies a path Pi split inside a word as one unbroken path", async () => {
	const target = "/home/developer/src/sample-api/doc/bugfix-rewrite-rda-sql-easysql.md";
	const terminal = new Terminal({ cols: 60, rows: 10 });
	const contentWidth = terminal.cols - 2;
	await write(terminal, [` ${target.slice(0, contentWidth)} `, ` ${target.slice(contentWidth)} `].join("\r\n"));

	assert.equal(copySelection(terminal, 0, 1), ` ${target} `);
});

test("restores the space Pi dropped when it wrapped between words", async () => {
	const terminal = new Terminal({ cols: 40, rows: 10 });
	const firstRow = "x".repeat(30);
	// The 9 following cells do not fit in the 38 content cells Pi wraps to.
	const continuation = "y".repeat(9);
	await write(terminal, [` ${firstRow} `, ` ${continuation} `].join("\r\n"));

	assert.equal(copySelection(terminal, 0, 1), ` ${firstRow} ${continuation} `);
});

test("keeps the newline where Pi never had to wrap", async () => {
	const terminal = new Terminal({ cols: 40, rows: 10 });
	// The next row's first word still fits beside the first row, so Pi printed two lines.
	await write(terminal, [` ${"x".repeat(30)} `, " yyy "].join("\r\n"));

	assert.equal(copySelection(terminal, 0, 1), ` ${"x".repeat(30)} \n yyy `);
});

test("keeps the newlines around blank rows and rendered blocks", async () => {
	const terminal = new Terminal({ cols: 40, rows: 10 });
	const filled = "x".repeat(terminal.cols - 2);
	await write(terminal, [` ${filled} `, " ".repeat(terminal.cols), ` ${filled} `, " - list item "].join("\r\n"));

	const blank = " ".repeat(terminal.cols);
	assert.equal(copySelection(terminal, 0, 3), ` ${filled} \n${blank}\n ${filled} \n - list item `);
});

test("leaves xterm's own soft wraps to xterm", async () => {
	const terminal = new Terminal({ cols: 24, rows: 10 });
	const text = "abcdefghijklmnopqrstuvwxyz0123456789";
	await write(terminal, text);
	assert.equal(terminal.buffer.active.getLine(1)?.isWrapped, true);

	assert.equal(copySelection(terminal, 0, 1), text);
});

test("keeps the newline after an xterm-wrapped line", async () => {
	const terminal = new Terminal({ cols: 24, rows: 10 });
	await write(terminal, `${ "a".repeat(terminal.cols * 2)}\r\nhello`);
	assert.equal(terminal.buffer.active.getLine(1)?.isWrapped, true);

	assert.equal(copySelection(terminal, 0, 2), `${ "a".repeat(terminal.cols * 2)}\nhello`);
});

// xterm's selection service needs a DOM, so reproduce the text it copies for a
// selection covering whole rows: one entry per row it did not wrap itself.
function copySelection(terminal: Terminal, startLine: number, endLine: number): string | undefined {
	const segments: string[] = [];
	for (let lineIndex = startLine; lineIndex <= endLine; lineIndex++) {
		const line = terminal.buffer.active.getLine(lineIndex);
		if (!line) assert.fail(`missing buffer line ${lineIndex}`);
		const text = line.translateToString(true);
		if (line.isWrapped && segments.length) segments[segments.length - 1] += text;
		else segments.push(text);
	}
	Object.assign(terminal, { getSelection: () => segments.join("\n") });
	return wrappedPathLinks.copySelectionText(terminal, {
		start: { x: 0, y: startLine },
		end: { x: terminal.cols, y: endLine },
	});
}

function write(terminal: Terminal, value: string): Promise<void> {
	return new Promise((resolve) => terminal.write(value, resolve));
}
