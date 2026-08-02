import { randomUUID } from "node:crypto";
import { chmodSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import * as pty from "node-pty";
import * as vscode from "vscode";
import {
	listWorkspaceSessions,
	NEW_SESSION_TITLE,
	sessionDirectoriesForWorkspace,
	type PiSession,
} from "./session-store";
import { becameIdle, PiStatusBridge, type PiSessionState, type PiStatusReport } from "./status-bridge";
import { httpUrl, resolveFileLink } from "./terminal-links";

interface RunningSession {
	tabId: string;
	sessionId: string;
	startedAtMs: number;
	title: string;
	path?: string;
	process: pty.IPty;
}

type ClientMessage =
	| { type: "ready" }
	| { type: "new" }
	| { type: "close-view" }
	| { type: "input"; id: string; data: string }
	| { type: "resize"; id: string; cols: number; rows: number }
	| { type: "refresh" }
	| { type: "resume"; id: string }
	| { type: "open-link"; kind: "file" | "url"; target: string };

const PI_VIEW_ID = "piAgent.view";
const PI_CONTAINER_COMMAND = "workbench.view.extension.piAgent";
const PI_CLOSE_SESSION_OR_VIEW_COMMAND = "piAgent.closeSessionOrView";
let ptyPrepared = false;
let piViewProvider: PiViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const provider = new PiViewProvider(context.extensionUri);
	piViewProvider = provider;
	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider(PI_VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("piAgent.open", () => provider.open()),
		vscode.commands.registerCommand(PI_CLOSE_SESSION_OR_VIEW_COMMAND, () => provider.closeSessionOrView()),
	);
}

export function deactivate(): void {
	piViewProvider?.dispose();
	piViewProvider = undefined;
}

function currentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
		if (activeFolder?.uri.fsPath) return activeFolder;
	}
	return vscode.workspace.workspaceFolders?.find((folder) => Boolean(folder.uri.fsPath));
}

class PiViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private panel: PiPanel | undefined;
	private cwd: string | undefined;
	private disposed = false;

	constructor(private readonly extensionUri: vscode.Uri) {}

	async open(): Promise<void> {
		const folder = currentWorkspaceFolder();
		if (!folder) {
			await vscode.window.showErrorMessage("Pi needs an open workspace folder.");
			return;
		}

		this.cwd = folder.uri.fsPath;
		await vscode.commands.executeCommand(PI_CONTAINER_COMMAND);
		this.view?.show();
		this.createPanel();
	}

	closeSessionOrView(): void {
		this.panel?.closeActiveSessionOrView();
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		if (this.disposed) return;
		this.view = webviewView;
		webviewView.onDidDispose(() => {
			if (this.view !== webviewView) return;
			this.view = undefined;
			this.panel?.dispose();
		});
		this.createPanel();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.panel?.dispose();
		this.panel = undefined;
		this.view = undefined;
	}

	private createPanel(): void {
		if (this.disposed || this.panel || !this.view) return;
		const cwd = this.cwd ?? currentWorkspaceFolder()?.uri.fsPath;
		if (!cwd) {
			this.view.webview.html = "<!doctype html><body>Open a workspace folder to use Pi.</body>";
			return;
		}

		this.cwd = cwd;
		let panel: PiPanel;
		panel = new PiPanel(this.extensionUri, cwd, this.view, () => {
			if (this.panel === panel) this.panel = undefined;
		});
		this.panel = panel;
	}
}

class PiPanel implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly sessions = new Map<string, RunningSession>();
	private readonly history = new Map<string, PiSession>();
	private readonly sessionStates = new Map<string, PiSessionState>();
	private readonly statusSequences = new Map<string, { sourceId: string; seq: number }>();
	private readonly historyWatchers = new Map<string, FSWatcher>();
	private readonly messageQueue: object[] = [];
	private readonly pendingStarts: Array<{ id: string; sessionPath?: string }> = [];
	private readonly statusBridge: PiStatusBridge;
	private refreshTimer: NodeJS.Timeout | undefined;
	private historyWatchSyncing = false;
	private statusBridgeReady = false;
	private ready = false;
	private disposed = false;
	private cols = 80;
	private rows = 24;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly cwd: string,
		private readonly panel: vscode.WebviewView,
		private readonly onDispose: () => void,
	) {
		this.statusBridge = new PiStatusBridge((report) => this.handleStatusReport(report));
		this.panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(extensionUri, "media"),
				vscode.Uri.joinPath(extensionUri, "node_modules"),
			],
		};
		this.panel.webview.html = webviewHtml(this.panel.webview, extensionUri);
		this.panel.webview.onDidReceiveMessage((message: unknown) => void this.receive(message), undefined, this.disposables);
		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

		void this.refreshHistory();
		void this.statusBridge
			.start()
			.catch((error) => vscode.window.showWarningMessage(`Pi session status unavailable: ${errorMessage(error)}`))
			.finally(() => {
				this.statusBridgeReady = true;
				if (this.disposed) return;
				this.startNewSession();
				for (const pending of this.pendingStarts.splice(0)) this.startSession(pending.id, pending.sessionPath);
			});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		for (const watcher of this.historyWatchers.values()) watcher.close();
		this.historyWatchers.clear();
		void this.statusBridge.dispose();
		for (const session of this.sessions.values()) session.process.kill();
		this.sessions.clear();
		this.pendingStarts.length = 0;
		for (const disposable of this.disposables) disposable.dispose();
		this.onDispose();
	}

	private async receive(message: unknown): Promise<void> {
		if (!isClientMessage(message) || this.disposed) return;
		switch (message.type) {
			case "ready":
				this.ready = true;
				for (const queued of this.messageQueue.splice(0)) void this.panel.webview.postMessage(queued);
				break;
			case "new":
				this.startNewSession();
				break;
			case "close-view":
				await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
				break;
			case "input":
				if (message.data.length <= 1024 * 1024) this.sessions.get(message.id)?.process.write(message.data);
				break;
			case "resize":
				this.resize(message.id, message.cols, message.rows);
				break;
			case "refresh":
				await this.refreshHistory();
				break;
			case "resume":
				this.resumeSession(message.id);
				break;
			case "open-link":
				await this.openLink(message.kind, message.target);
				break;
		}
	}

	private async openLink(kind: "file" | "url", target: string): Promise<void> {
		try {
			if (kind === "url") {
				const url = httpUrl(target);
				if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
				return;
			}

			const file = resolveFileLink(target, this.cwd);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file.path));
			let selection: vscode.Range | undefined;
			if (file.line !== undefined) {
				const line = Math.min(file.line, document.lineCount - 1);
				const column = Math.min(file.column ?? 0, document.lineAt(line).range.end.character);
				selection = new vscode.Range(line, column, line, column);
			}
			await vscode.window.showTextDocument(document, { preview: true, selection });
		} catch {
			// Terminal output can refer to files that no longer exist.
		}
	}

	private startNewSession(): void {
		this.startSession(randomUUID());
	}

	private resumeSession(id: string): void {
		const openSession = this.openSessionFor(id);
		if (openSession) {
			this.post({ type: "select", id: openSession.tabId });
			return;
		}
		const session = this.history.get(id);
		if (session) this.startSession(id, session.path);
	}

	private startSession(id: string, sessionPath?: string): void {
		if (!this.statusBridgeReady) {
			this.pendingStarts.push({ id, sessionPath });
			return;
		}
		const command = vscode.workspace.getConfiguration("piAgent").get<string>("command", "pi").trim();
		if (!command) {
			void vscode.window.showErrorMessage("Set piAgent.command to the pi executable.");
			return;
		}

		try {
			preparePty();
			const tabId = id;
			const args = sessionPath ? ["--session", sessionPath] : ["--session-id", id];
			if (this.statusBridge.isListening) args.push("--extension", piStatusExtensionPath(this.extensionUri));
			const process = pty.spawn(command, args, {
				cwd: this.cwd,
				name: "xterm-256color",
				cols: this.cols,
				rows: this.rows,
				env: { ...terminalEnvironment(), ...this.statusBridge.environmentFor(tabId) },
			});
			const title = this.titleForSession(id);
			const session: RunningSession = { tabId, sessionId: id, startedAtMs: Date.now(), title, path: sessionPath, process };
			this.sessions.set(tabId, session);
			this.statusSequences.delete(tabId);
			this.sessionStates.set(id, "starting");
			process.onData((data) => {
				this.post({ type: "data", id: tabId, data });
				this.refreshSoon();
			});
			process.onExit(({ exitCode }) => this.handleExit(tabId, process, exitCode));
			this.post({ type: "session-open", id: tabId, title });
			this.postHistory();
			this.refreshSoon();
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not start pi: ${errorMessage(error)}`);
		}
	}

	private handleExit(tabId: string, process: pty.IPty, exitCode: number): void {
		const session = this.sessions.get(tabId);
		if (this.disposed || session?.process !== process) return;
		this.sessions.delete(tabId);
		this.statusSequences.delete(tabId);
		this.sessionStates.set(session.sessionId, "inactive");
		this.postHistory();
		this.post({ type: "session-exit", id: tabId, exitCode });
		this.refreshSoon();
	}

	private resize(id: string, cols: number, rows: number): void {
		if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
		this.cols = clamp(cols, 2, 1000);
		this.rows = clamp(rows, 1, 500);
		this.sessions.get(id)?.process.resize(this.cols, this.rows);
	}

	private async refreshHistory(): Promise<void> {
		const sessions = await listWorkspaceSessions(this.cwd);
		if (this.disposed) return;
		this.history.clear();
		for (const session of sessions) this.history.set(session.id, session);
		this.syncSessionTitles();
		this.postHistory();
		void this.syncHistoryWatchers();
	}

	private handleStatusReport(report: PiStatusReport): void {
		const session = this.sessions.get(report.tabId);
		if (!session) return;
		const previous = this.statusSequences.get(report.tabId);
		if (previous?.sourceId === report.sourceId && previous.seq >= report.seq) return;
		this.statusSequences.set(report.tabId, { sourceId: report.sourceId, seq: report.seq });
		const previousState = this.sessionStates.get(session.sessionId);
		if (session.sessionId !== report.sessionId) {
			this.sessionStates.set(session.sessionId, "inactive");
			session.sessionId = report.sessionId;
			session.startedAtMs = Date.now();
			this.setSessionTitle(session, this.titleForSession(report.sessionId));
		}
		if (report.sessionPath) session.path = report.sessionPath;
		this.sessionStates.set(report.sessionId, report.state);
		if (becameIdle(previousState, report.state)) this.post({ type: "attention" });
		this.postHistory();
	}

	private openSessionFor(sessionId: string): RunningSession | undefined {
		return [...this.sessions.values()].find((session) => session.sessionId === sessionId);
	}

	private titleForSession(sessionId: string): string {
		return this.history.get(sessionId)?.title ?? NEW_SESSION_TITLE;
	}

	private syncSessionTitles(): void {
		for (const session of this.sessions.values()) this.setSessionTitle(session, this.titleForSession(session.sessionId));
	}

	private setSessionTitle(session: RunningSession, title: string): void {
		if (session.title === title) return;
		session.title = title;
		this.post({ type: "session-title", id: session.tabId, title });
	}

	private async syncHistoryWatchers(): Promise<void> {
		if (this.disposed || this.historyWatchSyncing) return;
		this.historyWatchSyncing = true;
		try {
			const directories = new Set(await sessionDirectoriesForWorkspace(this.cwd));
			if (this.disposed) return;
			for (const [directory, watcher] of this.historyWatchers) {
				if (directories.has(directory)) continue;
				watcher.close();
				this.historyWatchers.delete(directory);
			}
			for (const directory of directories) {
				if (this.historyWatchers.has(directory)) continue;
				try {
					const watcher = watch(directory, { persistent: false }, () => this.refreshSoon());
					watcher.on("error", () => {
						if (this.historyWatchers.get(directory) !== watcher) return;
						watcher.close();
						this.historyWatchers.delete(directory);
						this.refreshSoon();
					});
					this.historyWatchers.set(directory, watcher);
				} catch {
					// Pi creates a workspace session directory on startup; the next refresh retries this watch.
				}
			}
		} finally {
			this.historyWatchSyncing = false;
		}
	}

	private postHistory(): void {
		const sessions = [...this.history.values()].map(({ id, title, createdAtMs }) => {
			const openSession = this.openSessionFor(id);
			return {
				id,
				title,
				createdAtMs,
				tabId: openSession?.tabId,
				state: this.sessionStates.get(id) ?? (openSession ? "starting" : "inactive"),
			};
		});
		for (const session of this.sessions.values()) {
			if (this.history.has(session.sessionId)) continue;
			sessions.push({
				id: session.sessionId,
				title: session.title,
				createdAtMs: session.startedAtMs,
				tabId: session.tabId,
				state: this.sessionStates.get(session.sessionId) ?? "starting",
			});
		}
		sessions.sort((a, b) => b.createdAtMs - a.createdAtMs);
		this.post({ type: "history", sessions });
	}

	private refreshSoon(): void {
		if (this.disposed || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refreshHistory();
		}, 500);
	}

	private post(message: object): void {
		if (this.disposed) return;
		if (!this.ready) {
			// ponytail: cap pre-ready terminal output; add durable replay only if startup output can exceed this.
			if (this.messageQueue.length < 256) this.messageQueue.push(message);
			return;
		}
		void this.panel.webview.postMessage(message);
	}

	closeActiveSessionOrView(): void {
		this.post({ type: "close-active-session-or-view" });
	}
}

function preparePty(): void {
	if (ptyPrepared || process.platform === "win32") return;
	ptyPrepared = true;
	const packageDir = dirname(require.resolve("node-pty/package.json"));
	for (const helper of [
		join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
		join(packageDir, "build", "Release", "spawn-helper"),
	]) {
		try {
			chmodSync(helper, 0o755);
		} catch {
			// A source or Windows install may not have this helper.
		}
	}
}

function piStatusExtensionPath(extensionUri: vscode.Uri): string {
	return vscode.Uri.joinPath(extensionUri, "resources", "pi-vscode-status.ts").fsPath;
}

function terminalEnvironment(): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isClientMessage(value: unknown): value is ClientMessage {
	if (!value || typeof value !== "object" || !("type" in value)) return false;
	const message = value as Record<string, unknown>;
	if (typeof message.type !== "string") return false;
	if (message.type === "ready" || message.type === "refresh" || message.type === "new" || message.type === "close-view") return true;
	if (message.type === "input") return typeof message.id === "string" && typeof message.data === "string";
	if (message.type === "resize") {
		return typeof message.id === "string" && typeof message.cols === "number" && typeof message.rows === "number";
	}
	if (message.type === "open-link") {
		return (
			(message.kind === "file" || message.kind === "url") &&
			typeof message.target === "string" &&
			message.target.length <= 8192
		);
	}
	return message.type === "resume" && typeof message.id === "string";
}

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const uri = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
	const nonce = randomUUID();
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${uri("node_modules", "@xterm", "xterm", "css", "xterm.css")}">
	<link rel="stylesheet" href="${uri("media", "main.css")}">
	<title>Pi</title>
</head>
<body>
	<div id="app">
		<main id="terminal-pane" aria-label="Pi terminals">
			<div id="tabbar">
				<nav id="tabs" aria-label="Open Pi sessions"></nav>
				<button id="show-history" class="icon-button" type="button" title="Show sessions" aria-label="Show sessions" hidden>☰</button>
				<button id="new-tab" class="icon-button" type="button" title="New Pi session" aria-label="New Pi session">+</button>
			</div>
			<div id="terminal-hosts"></div>
		</main>
		<aside id="history-pane" aria-label="Pi session history">
			<header>
				<h1>Sessions</h1>
				<div id="history-actions">
					<button id="new-session" type="button" title="New Pi session"><span class="new-icon" aria-hidden="true">+</span>New</button>
					<button id="refresh" type="button" title="Refresh sessions" aria-label="Refresh sessions">↻</button>
					<button id="hide-history" type="button" title="Hide sessions" aria-label="Hide sessions">◀</button>
				</div>
			</header>
			<div id="history"></div>
		</aside>
	</div>
	<div id="context-menu" role="menu" hidden>
		<button id="context-hide" type="button" role="menuitem">Hide terminal</button>
	</div>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "xterm", "lib", "xterm.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-web-links", "lib", "addon-web-links.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "wrapped-path-links.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "main.js")}"></script>
</body>
</html>`;
}
