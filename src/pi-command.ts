/**
 * Windows spawn preparation. node-pty launches executables via CreateProcess,
 * which neither resolves `.cmd`/`.bat` shims on PATH (no PATHEXT probing) nor
 * runs them at all. npm's global `pi` is exactly such a shim (`pi.cmd`), so on
 * Windows the command is routed through `cmd.exe`, which resolves PATH +
 * PATHEXT like a shell. Real `.exe`/`.com` paths spawn directly.
 */

/** Quotes an argument for cmd.exe: wraps in double quotes when it contains whitespace or quotes. */
export function cmdQuote(arg: string): string {
	if (!/[\s"]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '\\"')}"`;
}

export function cmdCommandLine(file: string, args: string[]): string {
	return [file, ...args].map(cmdQuote).join(" ");
}

export function win32Spawn(file: string, args: string[]): { file: string; args: string[] } {
	// Absolute Windows path (drive letter or UNC) ending in a real executable.
	if ((/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith("\\\\")) && /\.(exe|com)$/i.test(file)) {
		return { file, args };
	}
	return { file: "cmd.exe", args: ["/d", "/s", "/c", cmdCommandLine(file, args)] };
}
