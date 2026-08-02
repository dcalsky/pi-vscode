(() => {
	const vscode = acquireVsCodeApi();
	const config = window.MRE_CONFIG;
	const bodyStyle = getComputedStyle(document.body);
	const terminal = new Terminal({
		cols: 38,
		rows: 12,
		convertEol: true,
		cursorBlink: false,
		fontFamily: bodyStyle.getPropertyValue("--vscode-editor-font-family").trim() || "monospace",
		fontSize: 13,
		disableStdin: true,
		theme: {
			background: "#1e1e1e",
			foreground: "#d4d4d4",
			cyan: "#9cdcfe",
		},
	});

	function modifierHeld(event) {
		return event.metaKey || event.ctrlKey;
	}

	function activate(kind, event, target) {
		if (!modifierHeld(event)) {
			setActivation(`Detected ${kind}; hold Cmd/Ctrl while clicking to open`);
			return;
		}
		event.preventDefault();
		setActivation(`${kind.toUpperCase()}: ${target}`);
		vscode.postMessage({ type: kind === "file" ? "open-file" : "open-url", target });
	}

	terminal.registerLinkProvider(
		WrappedPathLinks.createPathLinkProvider(terminal, (event, target) => activate("file", event, target)),
	);
	terminal.loadAddon(new WebLinksAddon.WebLinksAddon((event, target) => activate("url", event, target)));
	terminal.open(document.getElementById("terminal"));
	terminal.write(`FILE ${config.fixturePath}\r\n`, () => {
		terminal.write(`URL  ${config.testUrl}`, renderBufferCheck);
	});

	function renderBufferCheck() {
		const matchingRows = [];
		const ranges = new Set();
		for (let y = 1; y <= terminal.buffer.active.length; y++) {
			const link = WrappedPathLinks.computePathLinks(terminal, y).find((candidate) => candidate.text === config.fixturePath);
			if (!link) continue;
			matchingRows.push(y);
			ranges.add(JSON.stringify(link.range));
		}
		const range = ranges.size === 1 ? JSON.parse([...ranges][0]) : undefined;
		const wrappedFlags = range
			? Array.from({ length: range.end.y - range.start.y + 1 }, (_, offset) =>
					Boolean(terminal.buffer.active.getLine(range.start.y - 1 + offset)?.isWrapped),
			  )
			: [];
		const passed = matchingRows.length > 1 && ranges.size === 1 && wrappedFlags[0] === false && wrappedFlags.slice(1).every(Boolean);
		const output = document.getElementById("buffer-check");
		output.className = passed ? "pass" : "fail";
		output.textContent = passed
			? `PASS — rows ${matchingRows.join(", ")} return one range ${JSON.stringify(range)}`
			: `FAIL — rows=${matchingRows.join(",")} ranges=${ranges.size} isWrapped=${wrappedFlags.join(",")}`;
	}

	function setActivation(message) {
		document.getElementById("activation").textContent = message;
	}

	window.addEventListener("message", (event) => {
		if (event.data?.type !== "open-result") return;
		setActivation(event.data.ok ? `OPENED ${event.data.kind.toUpperCase()}: ${event.data.target}` : `ERROR: ${event.data.message}`);
	});
})();
