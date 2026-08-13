import assert from "node:assert/strict";
import test from "node:test";
import { normalizePiTerminalCopy } from "../terminal-copy";

test("joins a path Pi split at the content edge", () => {
	const target = "/home/developer/src/sample-api/doc/bugfix-rewrite-rda-sql-easysql.md";
	const cols = 60;
	const width = cols - 2;
	const copied = [` ${target.slice(0, width)} `, ` ${target.slice(width)} `].join("\n");
	assert.equal(normalizePiTerminalCopy(copied, cols), ` ${target} `);
});

test("restores a dropped word-wrap space but preserves real line breaks", () => {
	assert.equal(normalizePiTerminalCopy(`${"x".repeat(30)}\n${"y".repeat(9)}`, 40), `${"x".repeat(30)} ${"y".repeat(9)}`);
	assert.equal(normalizePiTerminalCopy(`${"x".repeat(20)}\nyyy`, 40), `${"x".repeat(20)}\nyyy`);
	assert.equal(normalizePiTerminalCopy(`${"x".repeat(39)}\n- list item`, 40), `${"x".repeat(39)}\n- list item`);
});

test("counts CJK text using terminal cell widths", () => {
	assert.equal(normalizePiTerminalCopy("中文中文\ncontinuation", 10), "中文中文 continuation");
});
