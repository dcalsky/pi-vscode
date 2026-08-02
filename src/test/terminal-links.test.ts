import assert from "node:assert/strict";
import test from "node:test";
import { httpUrl, resolveFileLink } from "../terminal-links";

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
