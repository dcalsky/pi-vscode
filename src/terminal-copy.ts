/**
 * Pi renders Markdown wrapping as physical PTY rows. VS Code already removes its
 * own xterm soft-wrap boundaries when copying; this restores only Pi's physical
 * wrap boundaries using the same width rule as the renderer.
 */
export function normalizePiTerminalCopy(text: string, cols: number): string {
	const separator = text.includes("\r\n") ? "\r\n" : "\n";
	const rows = text.split(separator);
	if (rows.length < 2 || cols < 2) return text;
	let result = rows[0];
	for (let index = 1; index < rows.length; index++) {
		const previous = rows[index - 1];
		const current = rows[index];
		const joiner = wrapJoiner(previous, current, cols);
		if (joiner === undefined) result += separator + current;
		else result = result.replace(/ +$/, "") + joiner + current.replace(/^ +/, "");
	}
	return result;
}

function wrapJoiner(previous: string, current: string, cols: number): string | undefined {
	const text = previous.trimEnd();
	const nextText = current.trimEnd();
	if (!text || !nextText || /^(?:[-*+]|\d+[.)])\s|^[│├┌└┐┘┤─]|^`{3}/.test(nextText.trimStart())) {
		return undefined;
	}
	if (cellWidth(text) >= cols - 1) return "";
	const word = /^\S+/.exec(nextText.trimStart())?.[0];
	if (!word) return undefined;
	return cellWidth(text) + 1 + cellWidth(word) > cols - 1 ? " " : undefined;
}

// Terminal output is overwhelmingly ASCII, but count the common wide and combining
// ranges so CJK prose around a wrapped path follows xterm's cell measurements.
function cellWidth(value: string): number {
	let width = 0;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (isCombining(code)) continue;
		width += isWide(code) ? 2 : 1;
	}
	return width;
}

function isCombining(code: number): boolean {
	return (
		(code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x1ab0 && code <= 0x1aff) ||
		(code >= 0x1dc0 && code <= 0x1dff) ||
		(code >= 0x20d0 && code <= 0x20ff) ||
		(code >= 0xfe20 && code <= 0xfe2f)
	);
}

function isWide(code: number): boolean {
	return (
		code >= 0x1100 &&
		(code <= 0x115f ||
			code === 0x2329 ||
			code === 0x232a ||
			(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe10 && code <= 0xfe19) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1f300 && code <= 0x1faff) ||
			(code >= 0x20000 && code <= 0x3fffd))
	);
}
