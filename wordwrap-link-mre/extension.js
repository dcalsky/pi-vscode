const path = require("node:path");
const vscode = require("vscode");

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand("wrappedLinkMre.open", () => openPanel(context)),
	);
}

function openPanel(context) {
	const extensionUri = context.extensionUri;
	const panel = vscode.window.createWebviewPanel(
		"wrappedLinkMre",
		"Wrapped Terminal Link MRE",
		vscode.ViewColumn.One,
		{ enableScripts: true },
	);
	const fixturePath = path.join(extensionUri.fsPath, "fixtures", "a-very-long-file-name-used-to-verify-soft-wrapped-terminal-links.md");
	const testUrl = "https://example.com/a/very/long/path/used/to/verify/soft-wrapped-terminal-links";
	panel.webview.html = webviewHtml(panel.webview, extensionUri, { fixturePath, testUrl });

	panel.webview.onDidReceiveMessage(
		async (message) => {
			if (!message || typeof message !== "object") return;
			try {
				if (message.type === "open-file" && message.target === fixturePath) {
					const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixturePath));
					await vscode.window.showTextDocument(document, { preview: true });
					void panel.webview.postMessage({ type: "open-result", ok: true, kind: "file", target: fixturePath });
				} else if (message.type === "open-url" && message.target === testUrl) {
					await vscode.env.openExternal(vscode.Uri.parse(testUrl));
					void panel.webview.postMessage({ type: "open-result", ok: true, kind: "url", target: testUrl });
				}
			} catch (error) {
				void panel.webview.postMessage({
					type: "open-result",
					ok: false,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		},
		undefined,
		context.subscriptions,
	);
}

function webviewHtml(webview, extensionUri, config) {
	const uri = (...segments) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
	const nonce = Math.random().toString(36).slice(2);
	const serializedConfig = JSON.stringify(config).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
	<link rel="stylesheet" href="${uri("node_modules", "@xterm", "xterm", "css", "xterm.css")}">
	<link rel="stylesheet" href="${uri("media", "main.css")}">
	<title>Wrapped Terminal Link MRE</title>
</head>
<body>
	<h1>Wrapped terminal link MRE</h1>
	<p>The terminal is fixed at <strong>38 columns</strong>. Both targets are written as one logical line and wrapped only by xterm.</p>
	<p>Hover any fragment: the whole wrapped target should underline. Hold <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> and click either the first or a continuation row.</p>
	<div id="terminal" aria-label="Wrapped link test terminal"></div>
	<dl class="results">
		<div><dt>Buffer check</dt><dd id="buffer-check">Waiting…</dd></div>
		<div><dt>Last activation</dt><dd id="activation">None</dd></div>
	</dl>
	<script nonce="${nonce}">window.MRE_CONFIG = ${serializedConfig};</script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "xterm", "lib", "xterm.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-web-links", "lib", "addon-web-links.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "wrapped-path-links.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "main.js")}"></script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
