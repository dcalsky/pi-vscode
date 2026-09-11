import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { httpUrl, resolveFileLink, terminalLineLinks } from "../terminal-links";

test("resolves terminal file paths and source locations", () => {
	// Links resolve to native paths, so build the fixtures and expectations with the
	// same path primitives rather than hard-coding POSIX separators.
	const cwd = resolve("/workspace");
	const home = resolve("/home/test");
	assert.deepEqual(resolveFileLink("src/extension.ts:12:4", cwd, home), {
		path: join(cwd, "src", "extension.ts"),
		line: 11,
		column: 3,
	});
	assert.deepEqual(resolveFileLink("~/notes.md", cwd, home), { path: join(home, "notes.md") });
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
