// Keyboard copy/paste for the terminal. VS Code's webview wrapper (pre/index.html's
// handleInnerKeydown) preventDefaults every native clipboard keydown in Electron and
// forwards it to the workbench, which only re-dispatches it for webview panels —
// webview views never get it back. The context menu works because it runs
// document.execCommand directly, so keyboard shortcuts take the same route here.
//
// The key table mirrors the integrated terminal's own keybindings
// (workbench.action.terminal.copySelection / copyAndClearSelection / paste):
//   macOS:   Cmd+C copies with a selection, Cmd+V pastes. Nothing else is bound.
//   Windows: Ctrl+C copies (and clears) with a selection, Ctrl+Shift+C copies,
//            Ctrl+V and Ctrl+Shift+V paste. Plain Ctrl+C without a selection is ^C.
//   Linux:   Ctrl+Shift+C copies, Ctrl+Shift+V pastes; plain Ctrl+C stays ^C and
//            plain Ctrl+V stays ^V, exactly like the integrated terminal.
// Find/search inputs use the plain browser convention on every platform.
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.PiClipboard = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
	const platform = (typeof navigator !== "undefined" && navigator.platform.toLowerCase()) || "";
	const IS_MAC = platform.includes("mac");
	const IS_LINUX = platform.includes("linux");

	// Returns "copy" | "copyAndClear" | "paste" | null. `hasSelection` describes the
	// focused terminal or input; `context.input` switches to browser conventions for
	// the find/search fields.
	function clipboardAction(event, hasSelection, context = {}) {
		if (event.type !== "keydown" || event.altKey) return null;
		const { isMac = IS_MAC, isLinux = IS_LINUX, input = false } = context;
		const key = event.key.toLowerCase();

		if (key === "v") {
			if (isMac) {
				if (event.metaKey && !event.ctrlKey && !event.shiftKey) return "paste";
			} else if (event.ctrlKey && !event.metaKey && (event.shiftKey || !isLinux || input)) {
				// On Linux the integrated terminal only binds Ctrl+Shift+V; plain Ctrl+V is ^V.
				return "paste";
			}
			return null;
		}
		if (key === "c" && hasSelection) {
			if (isMac) {
				if (event.metaKey && !event.ctrlKey && !event.shiftKey) return "copy";
			} else if (event.ctrlKey && !event.metaKey && (event.shiftKey || !isLinux || input)) {
				// Windows binds plain Ctrl+C to copyAndClearSelection; Ctrl+Shift+C only copies.
				return !isLinux && !event.shiftKey && !input ? "copyAndClear" : "copy";
			}
		}
		return null;
	}

	return { clipboardAction };
});
