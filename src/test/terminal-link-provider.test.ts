import assert from "node:assert/strict";
import test from "node:test";
import { Terminal } from "@xterm/xterm";

interface Link {
	text: string;
	range: {
		start: { x: number; y: number };
		end: { x: number; y: number };
	};
	activate(event: MouseEvent, text: string): void;
}

interface LinkProvider {
	provideLinks(line: number, callback: (links: Link[] | undefined) => void): void;
}

interface WrappedPathLinks {
	createPathLinkProvider(
		terminal: Terminal,
		activate: (event: MouseEvent, target: string, kind: "file" | "url") => void,
	): LinkProvider;
	computePathLinks(terminal: Terminal, bufferLineNumber: number): Link[];
}

const wrappedPathLinks = require("../../media/wrapped-path-links.js") as WrappedPathLinks;
Object.assign(globalThis, { self: globalThis });
const { WebLinksAddon } = require("@xterm/addon-web-links") as typeof import("@xterm/addon-web-links");

test("returns the full Pi session path from every xterm soft-wrap row", async () => {
	const posted: object[] = [];
	const terminal = new Terminal({ cols: 42, rows: 10 });
	const target = "/home/developer/src/sample-api/doc/bugfix-rewrite-rda-sql-easysql.md";
	const provider = wrappedPathLinks.createPathLinkProvider(terminal, (event, path) => {
		if (event.metaKey || event.ctrlKey) posted.push({ type: "open-link", kind: "file", target: path });
	});

	await write(terminal, `- ${target}`);
	const occupiedLines = nonEmptyLines(terminal);
	assert.deepEqual(
		occupiedLines.map(({ isWrapped }) => isWrapped),
		[false, true],
	);

	const links = occupiedLines.map(({ line }) => linksFor(provider, line + 1).find((link) => link.text === target));
	assert.ok(links.every((link): link is Link => Boolean(link)));
	assert.equal(new Set(links.map((link) => JSON.stringify(link.range))).size, 1);
	assert.deepEqual(links[0].range, {
		start: { x: 3, y: 1 },
		end: { x: 28, y: 2 },
	});

	links[1].activate({ metaKey: true, ctrlKey: false } as MouseEvent, links[1].text);
	assert.deepEqual(posted, [{ type: "open-link", kind: "file", target }]);
});

test("returns the full path from every Pi Markdown physical continuation row", async () => {
	const posted: object[] = [];
	const target = "/home/developer/src/sample-api/doc/bugfix-rewrite-rda-sql-easysql.md";
	const contentColumn = 2;
	const terminal = new Terminal({ cols: 62, rows: 10 });
	const firstChunkLength = terminal.cols - contentColumn;
	const firstRow = `- ${target.slice(0, firstChunkLength)}`;
	const continuationRow = `  ${target.slice(firstChunkLength)}`;
	assert.equal(firstRow.length, terminal.cols);

	const provider = wrappedPathLinks.createPathLinkProvider(terminal, (event, path) => {
		if (event.metaKey || event.ctrlKey) posted.push({ type: "open-link", kind: "file", target: path });
	});
	await write(terminal, `${firstRow}\r\n${continuationRow}`);

	const occupiedLines = nonEmptyLines(terminal);
	assert.deepEqual(
		occupiedLines.map(({ isWrapped }) => isWrapped),
		[false, false],
	);
	const links = occupiedLines.map(({ line }) => linksFor(provider, line + 1).find((link) => link.text === target));
	assert.ok(links.every((link): link is Link => Boolean(link)));
	assert.equal(new Set(links.map((link) => JSON.stringify(link.range))).size, 1);
	assert.deepEqual(links[0].range, {
		start: { x: 3, y: 1 },
		end: { x: contentColumn + target.length - firstChunkLength, y: 2 },
	});

	links[1].activate({ metaKey: true, ctrlKey: false } as MouseEvent, links[1].text);
	assert.deepEqual(posted, [{ type: "open-link", kind: "file", target }]);
});

test("returns the full path from Pi Markdown paragraph rows with output padding", async () => {
	const target = "/home/developer/src/sample-api/doc/bugfix-rewrite-rda-sql-easysql.md";
	// 58 content cells reproduces the screenshot split: `...-rda-sql-` + `easysql.md`.
	const terminal = new Terminal({ cols: 60, rows: 10 });
	const outputPadding = 1;
	const contentWidth = terminal.cols - outputPadding * 2;
	const physicalRows = [
		`${" ".repeat(outputPadding)}${target.slice(0, contentWidth)}${" ".repeat(outputPadding)}`,
		`${" ".repeat(outputPadding)}${target.slice(contentWidth)}${" ".repeat(outputPadding)}`,
	];
	await write(terminal, physicalRows.join("\r\n"));

	const occupiedLines = nonEmptyLines(terminal);
	assert.deepEqual(
		occupiedLines.map(({ isWrapped }) => isWrapped),
		[false, false],
	);
	const links = occupiedLines.map(({ line }) =>
		wrappedPathLinks.computePathLinks(terminal, line + 1).find((link) => link.text === target),
	);
	assert.ok(links.every((link): link is Link => Boolean(link)));
	assert.equal(new Set(links.map((link) => JSON.stringify(link.range))).size, 1);
	assert.deepEqual(links[0].range, {
		start: { x: 2, y: 1 },
		end: { x: outputPadding + target.length - contentWidth, y: 2 },
	});
});

test("opens a URL split into Pi Markdown physical rows as a URL", async () => {
	const activated: Array<{ target: string; kind: string }> = [];
	const target = "https://example.com/a/very/long/path/that/pi-renders-on-physical-rows";
	const terminal = new Terminal({ cols: 40, rows: 10 });
	const contentWidth = terminal.cols - 2;
	const provider = wrappedPathLinks.createPathLinkProvider(terminal, (_event, value, kind) => {
		activated.push({ target: value, kind });
	});
	await write(
		terminal,
		[` ${target.slice(0, contentWidth)} `, ` ${target.slice(contentWidth)} `].join("\r\n"),
	);

	const link = linksFor(provider, 2).find((candidate) => candidate.text === target);
	assert.ok(link);
	link.activate({ metaKey: true } as MouseEvent, link.text);
	assert.deepEqual(activated, [{ target, kind: "url" }]);
});

test("unified provider opens an unwrapped URL as a URL", async () => {
	const activated: Array<{ target: string; kind: string }> = [];
	const target = "https://example.com/docs/resource";
	const terminal = new Terminal({ cols: 80, rows: 5 });
	const provider = wrappedPathLinks.createPathLinkProvider(terminal, (_event, value, kind) => {
		activated.push({ target: value, kind });
	});
	await write(terminal, target);

	const link = linksFor(provider, 1).find((candidate) => candidate.text === target);
	assert.ok(link);
	link.activate({ metaKey: true } as MouseEvent, link.text);
	assert.deepEqual(activated, [{ target, kind: "url" }]);
});

test("does not merge adjacent Pi Markdown list items", async () => {
	const firstTarget = "/home/developer/src/sample-api/doc/bugfix-rewrite-rda-sql-easysql.md";
	const secondTarget = "/home/developer/src/sample-api/doc/decisions/ADR-pivot-table-tool-vs-subagent.md";
	const terminal = new Terminal({ cols: 62, rows: 10 });
	const physicalRows = [firstTarget, secondTarget].flatMap((target) => [
		`- ${target.slice(0, terminal.cols - 2)}`,
		`  ${target.slice(terminal.cols - 2)}`,
	]);
	await write(terminal, physicalRows.join("\r\n"));

	const links = nonEmptyLines(terminal).map(({ line }) => wrappedPathLinks.computePathLinks(terminal, line + 1));
	assert.deepEqual(
		links.map((lineLinks) => lineLinks.map((link) => link.text)),
		[[firstTarget], [firstTarget], [secondTarget], [secondTarget]],
	);
});

test("official URL provider returns one range across soft-wrap rows", async () => {
	const activated: string[] = [];
	const terminal = new Terminal({ cols: 30, rows: 10 });
	let provider: LinkProvider | undefined;
	terminal.registerLinkProvider = (candidate) => {
		provider = candidate as LinkProvider;
		return { dispose() {} };
	};
	terminal.loadAddon(new WebLinksAddon((_event, target) => activated.push(target)));
	if (!provider) assert.fail("WebLinksAddon did not register a link provider");
	const urlProvider = provider;

	const target = "https://example.com/a/very/long/path/to/resource";
	await write(terminal, `- ${target}`);
	const occupiedLines = nonEmptyLines(terminal);
	assert.deepEqual(
		occupiedLines.map(({ isWrapped }) => isWrapped),
		[false, true],
	);
	const links = occupiedLines.map(({ line }) => linksFor(urlProvider, line + 1).find((link) => link.text === target));
	assert.ok(links.every((link): link is Link => Boolean(link)));
	assert.equal(new Set(links.map((link) => JSON.stringify(link.range))).size, 1);

	links[1].activate({ metaKey: true } as MouseEvent, links[1].text);
	assert.deepEqual(activated, [target]);
});

test("keeps relative paths and source locations clickable", async () => {
	const terminal = new Terminal({ cols: 80, rows: 5 });
	await write(terminal, "docs/readme.md ./src/main.ts:12:3 ../package.json");
	const targets = wrappedPathLinks.computePathLinks(terminal, 1).map((link) => link.text);
	assert.deepEqual(targets, ["docs/readme.md", "./src/main.ts:12:3", "../package.json"]);
});

function linksFor(provider: LinkProvider, line: number): Link[] {
	let links: Link[] | undefined;
	provider.provideLinks(line, (value) => {
		links = value;
	});
	return links ?? [];
}

function nonEmptyLines(terminal: Terminal): Array<{ line: number; isWrapped: boolean }> {
	const result: Array<{ line: number; isWrapped: boolean }> = [];
	for (let line = 0; line < terminal.buffer.active.length; line++) {
		const candidate = terminal.buffer.active.getLine(line);
		if (candidate?.translateToString(true)) result.push({ line, isWrapped: candidate.isWrapped });
	}
	return result;
}

function write(terminal: Terminal, value: string): Promise<void> {
	return new Promise((resolve) => terminal.write(value, resolve));
}
