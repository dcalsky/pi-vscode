import assert from "node:assert/strict";
import test from "node:test";
import { httpUrl, resolveFileLink, terminalLineLinks } from "../terminal-links";

test("resolves terminal file paths and source locations", () => {
	assert.deepEqual(resolveFileLink("src/extension.ts:12:4", "/workspace", "/home/test"), {
		path: "/workspace/src/extension.ts",
		line: 11,
		column: 3,
	});
	assert.deepEqual(resolveFileLink("~/notes.md", "/workspace", "/home/test"), { path: "/home/test/notes.md" });
});

test("only accepts HTTP(S) URLs", () => {
	assert.equal(httpUrl("https://pi.dev/docs"), "https://pi.dev/docs");
	assert.equal(httpUrl("javascript:alert(1)"), undefined);
});

test("finds native terminal file, source and URL links", () => {
	assert.deepEqual(terminalLineLinks("See src/extension.ts:12:4 and https://pi.dev/docs."), [
		{ startIndex: 4, length: 21, target: "src/extension.ts:12:4", kind: "file" },
		{ startIndex: 30, length: 19, target: "https://pi.dev/docs", kind: "url" },
	]);
});
