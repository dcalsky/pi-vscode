const assert = require("node:assert/strict");
const test = require("node:test");
const { Terminal } = require("@xterm/xterm");
const { computePathLinks } = require("../media/wrapped-path-links");

test("returns one complete range for every visual row of a soft-wrapped path", async () => {
	const terminal = new Terminal({ cols: 24, rows: 10 });
	const target = "/workspace/docs/a-very-long-file-name-for-soft-wrap.md";
	await write(terminal, `FILE ${target}`);

	const occupied = [];
	for (let line = 0; line < terminal.buffer.active.length; line++) {
		const bufferLine = terminal.buffer.active.getLine(line);
		if (bufferLine?.translateToString(true)) occupied.push({ line, isWrapped: bufferLine.isWrapped });
	}
	assert.deepEqual(occupied.map(({ isWrapped }) => isWrapped), [false, true, true]);

	const links = occupied.map(({ line }) =>
		computePathLinks(terminal, line + 1).find((candidate) => candidate.text === target),
	);
	assert.ok(links.every(Boolean));
	assert.deepEqual(links.map((link) => link.text), [target, target, target]);
	assert.equal(new Set(links.map((link) => JSON.stringify(link.range))).size, 1);
	assert.deepEqual(links[0].range, {
		start: { x: 6, y: 1 },
		end: { x: 11, y: 3 },
	});
});

test("activation from a continuation row keeps the full path", async () => {
	const terminal = new Terminal({ cols: 24, rows: 10 });
	const target = "/workspace/docs/a-very-long-file-name-for-soft-wrap.md";
	const activated = [];
	await write(terminal, `FILE ${target}`);
	const link = computePathLinks(terminal, 2, (_event, text) => activated.push(text)).find(
		(candidate) => candidate.text === target,
	);
	assert.ok(link);
	link.activate({ metaKey: true }, link.text);
	assert.deepEqual(activated, [target]);
});

function write(terminal, value) {
	return new Promise((resolve) => terminal.write(value, resolve));
}
