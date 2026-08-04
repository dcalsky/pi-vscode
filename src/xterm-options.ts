// Mirrors VS Code's own terminal setup (src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts)
// so the webview terminal renders and behaves like the integrated one. Colors are not here: only the
// webview can read theme colors, so it fills in `theme` from its CSS variables.

export interface ConfigSection {
	get<T>(key: string, fallback: T): T;
}

export type ConfigReader = (section: string) => ConfigSection;

export interface PiTerminalOptions {
	/** Passed straight into the xterm constructor / assigned onto `term.options`. */
	xterm: Record<string, unknown>;
	/** Webview-side behaviours xterm has no option for. */
	gpuAcceleration: string;
	unicodeVersion: string;
	copyOnSelection: boolean;
	kittyKeyboard: boolean;
}

const CURSOR_STYLE: Record<string, string> = { block: "block", line: "bar", underline: "underline" };
const SMOOTH_SCROLL_DURATION = 125;

export function terminalOptions(read: ConfigReader): PiTerminalOptions {
	const terminal = read("terminal.integrated");
	const editor = read("editor");

	const gpuAcceleration = terminal.get("gpuAcceleration", "auto");
	const unicodeVersion = terminal.get("unicodeVersion", "11");
	const kittyKeyboard = terminal.get("enableKittyKeyboardProtocol", true);
	const enableImages = terminal.get("enableImages", false);
	const rightClickBehavior = terminal.get("rightClickBehavior", "selectWord");

	return {
		gpuAcceleration,
		unicodeVersion,
		kittyKeyboard,
		copyOnSelection: terminal.get("copyOnSelection", false),
		xterm: {
			allowProposedApi: true,
			fontFamily: terminal.get("fontFamily", "").trim() || editor.get("fontFamily", "monospace"),
			fontSize: clamp(terminal.get("fontSize", 12), 6, 100),
			fontWeight: terminal.get("fontWeight", "normal"),
			fontWeightBold: terminal.get("fontWeightBold", "bold"),
			lineHeight: Math.max(1, terminal.get("lineHeight", 1)),
			letterSpacing: terminal.get("letterSpacing", 0),
			cursorBlink: terminal.get("cursorBlinking", false),
			cursorStyle: CURSOR_STYLE[terminal.get("cursorStyle", "block")] ?? "block",
			cursorInactiveStyle: CURSOR_STYLE[terminal.get("cursorStyleInactive", "outline")] ?? "outline",
			cursorWidth: terminal.get("cursorWidth", 1),
			scrollback: terminal.get("scrollback", 1000),
			smoothScrollDuration: terminal.get("smoothScrolling", false) ? SMOOTH_SCROLL_DURATION : 0,
			minimumContrastRatio: terminal.get("minimumContrastRatio", 4.5),
			drawBoldTextInBrightColors: terminal.get("drawBoldTextInBrightColors", true),
			rescaleOverlappingGlyphs: terminal.get("rescaleOverlappingGlyphs", true),
			tabStopWidth: terminal.get("tabStopWidth", 8),
			macOptionIsMeta: terminal.get("macOptionIsMeta", false),
			macOptionClickForcesSelection: terminal.get("macOptionClickForcesSelection", false),
			rightClickSelectsWord: rightClickBehavior === "selectWord",
			altClickMovesCursor:
				terminal.get("altClickMovesCursor", true) && editor.get("multiCursorModifier", "alt") === "alt",
			wordSeparator: terminal.get("wordSeparators", " ()[]{}',\"`─‘’“”|"),
			fastScrollSensitivity: editor.get("fastScrollSensitivity", 5),
			scrollSensitivity: editor.get("mouseWheelScrollSensitivity", 1),
			scrollOnEraseInDisplay: true,
			// Width enables xterm's own scrollbar plus the overview ruler that shows find matches.
			scrollbar: { width: 14, overviewRuler: { showTopBorder: true } },
			ignoreBracketedPasteMode: terminal.get("ignoreBracketedPasteMode", false),
			allowTransparency: enableImages,
			vtExtensions: { kittyKeyboard },
		},
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
