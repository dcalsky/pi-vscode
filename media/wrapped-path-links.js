(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.WrappedPathLinks = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
	const targetPattern =
		/https?:\/\/[^\s"'`<>()\[\]{}|]+|(?:~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])[^\s"'`<>()\[\]{}|]+|(?:(?:[\w@.-]+[\\/])+[\w@.-]+|[\w@-]+\.[\w.-]+)(?::\d+(?::\d+)?)?/g;
	const continuationFragmentPattern = /^[^\s"'`<>()\[\]{}|]+/;

	function createPathLinkProvider(terminal, activate) {
		return {
			provideLinks(bufferLineNumber, callback) {
				const links = computePathLinks(terminal, bufferLineNumber, activate);
				callback(links.length ? links : undefined);
			},
		};
	}

	function computePathLinks(terminal, bufferLineNumber, activate = function () {}) {
		const logicalLine = logicalLineAt(terminal, bufferLineNumber - 1);
		if (logicalLine.startLineIndex !== logicalLine.endLineIndex) {
			return linksForLogicalLine(terminal, logicalLine, activate);
		}
		const renderedLinks = hardWrappedLinksAt(terminal, bufferLineNumber - 1, activate);
		return renderedLinks.length ? renderedLinks : linksForLogicalLine(terminal, logicalLine, activate);
	}

	function linksForLogicalLine(terminal, logicalLine, activate) {
		const { text } = logicalLine;
		const pattern = new RegExp(targetPattern.source, targetPattern.flags);
		const links = [];
		for (const match of text.matchAll(pattern)) {
			const target = match[0].replace(/[.,;!?]+$/, "");
			if (!target) continue;
			const start = mapLogicalIndex(terminal, logicalLine, match.index);
			const end = mapLogicalIndex(terminal, logicalLine, match.index + target.length);
			if (!start || !end) continue;
			const kind = targetKind(target);
			links.push({
				range: {
					start: { x: start.columnIndex + 1, y: start.lineIndex + 1 },
					end: { x: end.columnIndex, y: end.lineIndex + 1 },
				},
				text: target,
				activate: (event) => activate(event, target, kind),
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

	// Pi wraps Markdown before it reaches the PTY and emits the resulting rows with
	// CRLF. xterm correctly reports each one as a separate physical line. Recover a
	// rendered link from the link token itself: when the token reaches Pi's right
	// content edge (terminal width, optionally minus its one-cell output padding),
	// append the first non-space token from the next physical row. This works for
	// paragraphs and lists without pretending that unrelated rows are xterm wraps.
	function hardWrappedLinksAt(terminal, requestedLineIndex, activate) {
		const buffer = terminal.buffer.active;
		const links = [];
		const firstCandidateLine = Math.max(0, requestedLineIndex - 64);
		for (let lineIndex = firstCandidateLine; lineIndex <= requestedLineIndex; lineIndex++) {
			const line = buffer.getLine(lineIndex);
			if (!line || line.isWrapped) continue;
			const text = line.translateToString(true);
			const pattern = new RegExp(targetPattern.source, targetPattern.flags);
			for (const match of text.matchAll(pattern)) {
				const expanded = expandHardWrappedTarget(terminal, lineIndex, text, match.index, match[0]);
				if (!expanded || expanded.end.lineIndex === lineIndex) continue;
				if (requestedLineIndex < lineIndex || requestedLineIndex > expanded.end.lineIndex) continue;
				const kind = targetKind(expanded.target);
				links.push({
					range: {
						start: { x: expanded.start.columnIndex + 1, y: expanded.start.lineIndex + 1 },
						end: { x: expanded.end.columnIndex, y: expanded.end.lineIndex + 1 },
					},
					text: expanded.target,
					activate: (event) => activate(event, expanded.target, kind),
				});
			}
		}
		return deduplicateLinks(links);
	}

	function expandHardWrappedTarget(terminal, startLineIndex, firstText, matchIndex, initialTarget) {
		const buffer = terminal.buffer.active;
		const firstSegment = { lineIndex: startLineIndex, startColumn: 0, text: firstText };
		const startColumn = columnForStringOffset(terminal, firstSegment, matchIndex);
		let target = initialTarget;
		let currentLineIndex = startLineIndex;
		let currentText = firstText;
		let currentEndOffset = matchIndex + initialTarget.length;
		let endColumn = columnForStringOffset(terminal, firstSegment, currentEndOffset);

		while (reachesRenderedEdge(terminal, currentLineIndex, currentText, currentEndOffset)) {
			const nextLine = buffer.getLine(currentLineIndex + 1);
			if (!nextLine || nextLine.isWrapped) break;
			const nextText = nextLine.translateToString(true);
			const leadingWhitespace = /^ */.exec(nextText)?.[0].length ?? 0;
			const fragment = continuationFragmentPattern.exec(nextText.slice(leadingWhitespace))?.[0];
			if (!fragment) break;

			target += fragment;
			currentLineIndex++;
			currentText = nextText;
			currentEndOffset = leadingWhitespace + fragment.length;
			endColumn = columnForStringOffset(
				terminal,
				{ lineIndex: currentLineIndex, startColumn: 0, text: currentText },
				currentEndOffset,
			);
		}

		if (currentLineIndex === startLineIndex) return undefined;
		const trimmedTarget = target.replace(/[.,;!?]+$/, "");
		endColumn -= target.length - trimmedTarget.length;
		return {
			target: trimmedTarget,
			start: { lineIndex: startLineIndex, columnIndex: startColumn },
			end: { lineIndex: currentLineIndex, columnIndex: endColumn },
		};
	}

	function reachesRenderedEdge(terminal, lineIndex, text, targetEndOffset) {
		// Pi's output padding is either zero or one cell. The right padding is an
		// explicit space in xterm's buffer, so translateToString(true) preserves it.
		if (!/^ ?$/.test(text.slice(targetEndOffset))) return false;
		const endColumn = columnForStringOffset(
			terminal,
			{ lineIndex, startColumn: 0, text },
			targetEndOffset,
		);
		return endColumn >= terminal.cols - 1;
	}

	function deduplicateLinks(links) {
		const seen = new Set();
		return links.filter((link) => {
			const key = `${link.range.start.x}:${link.range.start.y}-${link.range.end.x}:${link.range.end.y}:${link.text}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	function targetKind(target) {
		return /^https?:\/\//i.test(target) ? "url" : "file";
	}

	function mapLogicalIndex(terminal, logicalLine, stringIndex) {
		const mapped = mapStringIndex(terminal, logicalLine.startLineIndex, 0, stringIndex);
		return mapped[0] < 0 || mapped[1] < 0
			? undefined
			: { lineIndex: mapped[0], columnIndex: mapped[1] };
	}

	function columnForStringOffset(terminal, segment, stringOffset) {
		const line = terminal.buffer.active.getLine(segment.lineIndex);
		if (!line) return -1;
		const cell = terminal.buffer.active.getNullCell();
		let consumed = 0;
		for (let column = segment.startColumn; column < line.length; column++) {
			line.getCell(column, cell);
			if (!cell.getWidth()) continue;
			if (consumed >= stringOffset) return column;
			const chars = cell.getChars();
			consumed += chars.length || 1;
			if (consumed >= stringOffset) return column + cell.getWidth();
		}
		return line.length;
	}

	// Mirrors xterm's official WebLinkProvider string-index mapping, including
	// its correction for a wide character that wraps before the last cell.
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
