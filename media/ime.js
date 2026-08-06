// Third-party IMEs (Sogou, Doubao…) commit Chinese punctuation without a composition
// session: the keydown arrives as a raw ASCII key (",", isComposing=false) and xterm
// would write the English char straight to the PTY, swallowing the IME's "，". For
// those keys the custom key handler in main.js returns false so the browser default
// runs and the IME commit lands in xterm's hidden textarea, where a capture-phase
// input listener forwards it to the PTY. Apple's own IME marks such keys keyCode 229,
// which xterm handles natively, and composition-session input is untouched.
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.PiIme = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
	// Punctuation and digit keys a Chinese IME turns into ，。、【】etc. Keyed by
	// event.code so shifted forms (《 ？ ：) are covered as well.
	const NATIVE_INPUT_CODES = new Set([
		"Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
		"Semicolon", "Quote", "Comma", "Period", "Slash",
		"Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
	]);

	// True when this keydown must go through the browser's native text input instead of
	// xterm's own key handling. Modifier combos stay shortcuts; keys already claimed by
	// an IME (composition session or keyCode 229) keep xterm's built-in path — without
	// that guard, digit selection of pinyin candidates would be hijacked.
	function nativeInputKey(event) {
		if (event.type !== "keydown" || event.isComposing || event.keyCode === 229) return false;
		if (event.ctrlKey || event.altKey || event.metaKey) return false;
		return NATIVE_INPUT_CODES.has(event.code);
	}

	return { nativeInputKey };
});
