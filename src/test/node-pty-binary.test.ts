import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

// node-pty 1.1.0's npm tarball ships prebuilt native binaries only for darwin and
// win32; Linux must compile from source during install. A VSIX packaged with the
// install scripts skipped therefore contains no pty.node for Linux, the extension
// host fails at require("node-pty") before activate() runs, and every command
// (piAgent.open, ...) reports "command not found". This test pins the requirement
// that the bundled node-pty carries a native binary for the platform we are on.
test("node-pty ships a native pty.node for the current platform", () => {
	const packageDir = dirname(require.resolve("node-pty/package.json"));
	const candidates = [
		join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "pty.node"),
		join(packageDir, "build", "Release", "pty.node"),
		join(packageDir, "build", "Debug", "pty.node"),
	];
	assert.ok(
		candidates.some(existsSync),
		`node-pty has no native pty.node for ${process.platform}-${process.arch}; ` +
			"the extension fails to activate and its commands report 'command not found'",
	);
});
