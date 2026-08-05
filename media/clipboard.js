// Keyboard copy/paste for the terminal. VS Code's webview wrapper (pre/index.html's
// handleInnerKeydown) preventDefaults every native clipboard keydown in Electron and
// forwards it to the workbench, which only re-dispatches it for webview panels —
// webview views never get it back. The context menu works because it runs
// document.execCommand directly, so keyboard shortcuts take the same route here.
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.PiClipboard = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
	const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

	// Mirrors the integrated terminal: Cmd/Ctrl+C copies only with a selection
	// (plain Ctrl+C without one still falls through to ^C), Cmd/Ctrl+V and
	// Shift+Insert paste. Returns "copy" | "paste" | null.
	function clipboardAction(event, hasSelection, isMac = IS_MAC) {
		if (event.type !== "keydown" || event.altKey) return null;
		const key = event.key.toLowerCase();
		if (key === "v" && (isMac ? event.metaKey : event.ctrlKey)) return "paste";
		if (key === "c" && !event.ctrlKey && event.metaKey && isMac && hasSelection) return "copy";
		if (key === "c" && event.ctrlKey && !event.metaKey && !isMac && hasSelection) return "copy";
		if (!isMac && event.key === "Insert" && event.shiftKey && !event.ctrlKey && !event.metaKey) return "paste";
		return null;
	}

	return { clipboardAction };
});
