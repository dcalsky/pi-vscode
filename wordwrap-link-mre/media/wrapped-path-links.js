(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.WrappedPathLinks = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
	const absolutePathPattern = /(?:^|(?<=[\s("'`]))(?:~\/|\/)[^\s"'`<>()\[\]{}|]+/g;

	function createPathLinkProvider(terminal, activate) {
		return {
			provideLinks(bufferLineNumber, callback) {
				const links = computePathLinks(terminal, bufferLineNumber, activate);
				callback(links.length ? links : undefined);
			},
		};
	}

	function computePathLinks(terminal, bufferLineNumber, activate = function () {}) {
		const { text, startLineIndex } = logicalLineAt(terminal, bufferLineNumber - 1);
		const pattern = new RegExp(absolutePathPattern.source, absolutePathPattern.flags);
		const links = [];
		for (const match of text.matchAll(pattern)) {
			const target = match[0].replace(/[.,;!?]+$/, "");
			if (!target) continue;
			const start = mapStringIndex(terminal, startLineIndex, 0, match.index);
			const end = mapStringIndex(terminal, start[0], start[1], target.length);
			if (start[0] < 0 || start[1] < 0 || end[0] < 0 || end[1] < 0) continue;
			links.push({
				range: {
					start: { x: start[1] + 1, y: start[0] + 1 },
					end: { x: end[1], y: end[0] + 1 },
				},
				text: target,
				activate,
			});
		}
		return links;
	}

	function logicalLineAt(terminal, lineIndex) {
		const buffer = terminal.buffer.active;
		let startLineIndex = lineIndex;
		while (startLineIndex > 0 && buffer.getLine(startLineIndex)?.isWrapped) startLineIndex--;
		let endLineIndex = lineIndex;
		while (buffer.getLine(endLineIndex + 1)?.isWrapped) endLineIndex++;
		const parts = [];
		for (let index = startLineIndex; index <= endLineIndex; index++) {
			const line = buffer.getLine(index);
			if (line) parts.push(line.translateToString(true));
		}
		return { text: parts.join(""), startLineIndex, endLineIndex };
	}

	// This is the same cell-by-cell string-index mapping used by xterm's
	// official WebLinkProvider, including its early-wrapped wide-char correction.
	function mapStringIndex(terminal, lineIndex, columnIndex, stringIndex) {
		const buffer = terminal.buffer.active;
		const cell = buffer.getNullCell();
		let startColumn = columnIndex;
		while (stringIndex) {
			const line = buffer.getLine(lineIndex);
			if (!line) return [-1, -1];
			for (let column = startColumn; column < line.length; column++) {
				line.getCell(column, cell);
				const chars = cell.getChars();
				if (cell.getWidth()) {
					stringIndex -= chars.length || 1;
					if (column === line.length - 1 && chars === "") {
						const nextLine = buffer.getLine(lineIndex + 1);
						if (nextLine?.isWrapped) {
							nextLine.getCell(0, cell);
							if (cell.getWidth() === 2) stringIndex++;
						}
					}
				}
				if (stringIndex < 0) return [lineIndex, column];
			}
			lineIndex++;
			startColumn = 0;
		}
		return [lineIndex, startColumn];
	}

	return { createPathLinkProvider, computePathLinks, logicalLineAt, mapStringIndex };
});
