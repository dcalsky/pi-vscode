import { randomUUID } from "node:crypto";
import { chmodSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as pty from "node-pty";
import * as vscode from "vscode";
import {
	deleteSessionFiles,
	listWorkspaceSessions,
	NEW_SESSION_TITLE,
	sessionDirectoriesForWorkspace,
	type PiSession,
} from "./session-store";
import {
	becameIdle,
	PiStatusBridge,
	type PiForkRequest,
	type PiSessionState,
	type PiStatusReport,
} from "./status-bridge";
import { httpUrl, resolveFileLink } from "./terminal-links";
import { normalizeViewState, setArchived, type PiViewState } from "./view-state";
import { terminalOptions } from "./xterm-options";

interface RunningSession {
	tabId: string;
	sessionId: string;
	startedAtMs: number;
	title: string;
	path?: string;
	/** False once its tab is closed: Pi keeps running, but the tab is not restored. */
	attached: boolean;
	process: pty.IPty;
}

interface StartSessionOptions {
	draftFile?: string;
	reportError?: boolean;
}

type ClientMessage =
	| { type: "ready" }
	| { type: "new" }
	| { type: "close-view" }
	| { type: "customize" }
	| { type: "input"; id: string; data: string }
	| { type: "resize"; id: string; cols: number; rows: number }
	| { type: "refresh" }
	| { type: "resume"; id: string }
	| { type: "focus"; id: string }
	| { type: "detach"; id: string }
	| { type: "shutdown"; id: string }
	| { type: "delete"; id: string }
	| { type: "archive"; id: string; archived: boolean }
	| { type: "open-link"; kind: "file" | "url"; target: string };

const PI_VIEW_ID = "piAgent.view";
const PI_CONTAINER_COMMAND = "workbench.view.extension.piAgent";
const PI_CLOSE_SESSION_OR_VIEW_COMMAND = "piAgent.closeSessionOrView";
const PI_VIEW_STATE_KEY = "piAgent.viewState";
const PI_FORK_DRAFT_FILE_ENV = "PI_VSCODE_FORK_DRAFT_FILE";
let ptyPrepared = false;
let piViewProvider: PiViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const provider = new PiViewProvider(context.extensionUri, context.workspaceState);
	piViewProvider = provider;
	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider(PI_VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("piAgent.open", () => provider.open()),
		vscode.commands.registerCommand("piAgent.newSession", () => provider.newSession()),
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

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly memento: vscode.Memento,
	) {}

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

	async newSession(): Promise<void> {
		if (!this.panel) {
			await this.open();
			return;
		}
		this.panel.startNewSession();
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
		panel = new PiPanel(this.extensionUri, cwd, this.view, this.memento, () => {
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
	private readonly pendingStarts: Array<{ id: string; sessionPath?: string; options?: StartSessionOptions }> = [];
	private readonly statusBridge: PiStatusBridge;
	private viewState: PiViewState;
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
		private readonly memento: vscode.Memento,
		private readonly onDispose: () => void,
	) {
		this.viewState = normalizeViewState(this.memento.get(PI_VIEW_STATE_KEY));
		this.statusBridge = new PiStatusBridge(
			(report) => this.handleStatusReport(report),
			(request) => this.handleForkRequest(request),
		);
		this.panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(extensionUri, "media"),
				vscode.Uri.joinPath(extensionUri, "node_modules"),
			],
		};
		this.panel.webview.html = webviewHtml(this.panel.webview, extensionUri);
		this.postTerminalOptions();
		vscode.workspace.onDidChangeConfiguration(
			(event) => {
				if (event.affectsConfiguration("terminal.integrated") || event.affectsConfiguration("editor")) {
					this.postTerminalOptions();
				}
			},
			undefined,
			this.disposables,
		);
		this.panel.webview.onDidReceiveMessage((message: unknown) => void this.receive(message), undefined, this.disposables);
		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

		void this.refreshHistory();
		void this.statusBridge
			.start()
			.catch((error) => vscode.window.showWarningMessage(`Pi session status unavailable: ${errorMessage(error)}`))
			.finally(() => {
				this.statusBridgeReady = true;
				if (this.disposed) return;
				this.restoreSessions();
				for (const pending of this.pendingStarts.splice(0)) {
					this.startSession(pending.id, pending.sessionPath, pending.options);
				}
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
			case "customize":
				await vscode.commands.executeCommand("workbench.action.openSettings", "piAgent");
				break;
			case "detach":
				this.detachSession(message.id);
				break;
			case "shutdown":
				this.shutdownSession(message.id);
				break;
			case "delete":
				await this.deleteSession(message.id);
				break;
			case "archive":
				this.archiveSession(message.id, message.archived);
				break;
			case "focus":
				this.setFocusedSession(message.id);
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

	startNewSession(): void {
		this.startSession(randomUUID());
	}

	private restoreSessions(): void {
		const restored = this.viewState.openSessions;
		// Each start persists the tab list again, which rewrites viewState, so read the
		// focused session before the loop.
		const focused = this.viewState.focusedSessionId;
		if (!restored.length) {
			this.startNewSession();
			return;
		}
		for (const record of restored) this.startSession(record.id, record.path);
		// The webview reports which tab it settled on, so focus is persisted again from there.
		const focusedSession = focused ? this.openSessionFor(focused) : undefined;
		if (focusedSession) this.post({ type: "select", id: focusedSession.tabId });
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

	/** Closing a tab leaves Pi running; the session can be reopened from the list. */
	private detachSession(tabId: string): void {
		const session = this.sessions.get(tabId);
		if (!session || !session.attached) return;
		session.attached = false;
		this.persistViewState();
	}

	private shutdownSession(tabId: string): void {
		const session = this.sessions.get(tabId);
		if (!session) return;
		this.sessions.delete(tabId);
		this.statusSequences.delete(tabId);
		this.sessionStates.set(session.sessionId, "inactive");
		session.process.kill();
		this.post({ type: "session-close", id: tabId });
		this.persistViewState();
		this.postHistory();
	}

	/** Deleting is keyed by session id, not tab id: a session can be deleted without a live tab. */
	private async deleteSession(sessionId: string): Promise<void> {
		const title = this.history.get(sessionId)?.title ?? this.openSessionFor(sessionId)?.title ?? NEW_SESSION_TITLE;
		const choice = await vscode.window.showWarningMessage(
			`Delete session "${title}"?`,
			{ modal: true, detail: "Pi stops and this session's saved files are removed from disk. This cannot be undone." },
			"Delete",
		);
		if (choice !== "Delete" || this.disposed) return;

		// ponytail: deletes right after the kill; wait for process exit only if Pi is seen re-creating the transcript.
		const open = this.openSessionFor(sessionId);
		if (open) this.shutdownSession(open.tabId);
		const path = this.history.get(sessionId)?.path ?? open?.path;
		try {
			if (path) await deleteSessionFiles(path);
		} catch (error) {
			// The next refresh restores whatever survived on disk.
			void vscode.window.showErrorMessage(`Could not delete "${title}": ${errorMessage(error)}`);
			return;
		}
		if (this.disposed) return;
		this.history.delete(sessionId);
		this.sessionStates.delete(sessionId);
		// The archive list is the only view state keyed by session id; the rest is rebuilt from live tabs.
		this.viewState = setArchived(this.viewState, sessionId, false);
		this.persistViewState();
		this.postHistory();
	}

	// Archiving only files the session under Archive; it leaves Pi and the tab alone.
	private archiveSession(sessionId: string, archived: boolean): void {
		this.viewState = setArchived(this.viewState, sessionId, archived);
		this.persistViewState();
		this.postHistory();
	}

	private setFocusedSession(tabId: string): void {
		const session = this.sessions.get(tabId);
		if (!session) return;
		if (session.attached && this.viewState.focusedSessionId === session.sessionId) return;
		session.attached = true;
		this.viewState = { ...this.viewState, focusedSessionId: session.sessionId };
		this.persistViewState();
	}

	private persistViewState(): void {
		if (this.disposed) return;
		const openSessions = [...this.sessions.values()]
			.filter((session) => session.attached)
			.map((session) => (session.path ? { id: session.sessionId, path: session.path } : { id: session.sessionId }));
		this.viewState = normalizeViewState({ ...this.viewState, openSessions });
		void this.memento.update(PI_VIEW_STATE_KEY, this.viewState);
	}

	private async handleForkRequest(request: PiForkRequest): Promise<void> {
		if (this.disposed) throw new Error("The Pi view is closed");
		const source = this.sessions.get(request.tabId);
		if (!source || source.sessionId !== request.sourceSessionId) {
			throw new Error("The source session is no longer open");
		}
		if (request.sessionId === request.sourceSessionId || this.openSessionFor(request.sessionId)) {
			throw new Error("The forked session is already open");
		}

		await this.refreshHistory();
		if (this.disposed) throw new Error("The Pi view is closed");
		const forked = this.history.get(request.sessionId);
		if (!forked || resolve(forked.path) !== resolve(request.sessionPath)) {
			throw new Error("The forked session is not available in this workspace");
		}

		const failure = this.startSession(request.sessionId, forked.path, {
			draftFile: request.draftFile,
			reportError: false,
		});
		if (failure) throw new Error(failure);
	}

	private startSession(id: string, sessionPath?: string, options: StartSessionOptions = {}): string | undefined {
		if (!this.statusBridgeReady) {
			this.pendingStarts.push({ id, sessionPath, options });
			return undefined;
		}
		const command = vscode.workspace.getConfiguration("piAgent").get<string>("command", "pi").trim();
		if (!command) {
			const failure = "Set piAgent.command to the pi executable.";
			if (options.reportError !== false) void vscode.window.showErrorMessage(failure);
			return failure;
		}

		let spawnedProcess: pty.IPty | undefined;
		try {
			preparePty();
			const tabId = id;
			const args = sessionPath ? ["--session", sessionPath] : ["--session-id", id];
			if (this.statusBridge.isListening) args.push("--extension", piStatusExtensionPath(this.extensionUri));
			const forkEnvironment = options.draftFile ? { [PI_FORK_DRAFT_FILE_ENV]: options.draftFile } : {};
			const process = pty.spawn(command, args, {
				cwd: this.cwd,
				name: "xterm-256color",
				cols: this.cols,
				rows: this.rows,
				env: { ...terminalEnvironment(), ...this.statusBridge.environmentFor(tabId), ...forkEnvironment },
			});
			spawnedProcess = process;
			const title = this.titleForSession(id);
			const session: RunningSession = {
				tabId,
				sessionId: id,
				startedAtMs: Date.now(),
				title,
				path: sessionPath,
				attached: true,
				process,
			};
			this.sessions.set(tabId, session);
			this.statusSequences.delete(tabId);
			this.sessionStates.set(id, "starting");
			process.onData((data) => {
				this.post({ type: "data", id: tabId, data });
				this.refreshSoon();
			});
			process.onExit(({ exitCode }) => this.handleExit(tabId, process, exitCode));
			this.post({ type: "session-open", id: tabId, sessionId: id, title });
			this.persistViewState();
			this.postHistory();
			this.refreshSoon();
			return undefined;
		} catch (error) {
			this.sessions.delete(id);
			this.sessionStates.delete(id);
			this.statusSequences.delete(id);
			spawnedProcess?.kill();
			const failure = `Could not start pi: ${errorMessage(error)}`;
			if (options.reportError !== false) void vscode.window.showErrorMessage(failure);
			return failure;
		}
	}

	private handleExit(tabId: string, process: pty.IPty, exitCode: number): void {
		const session = this.sessions.get(tabId);
		if (this.disposed || session?.process !== process) return;
		this.sessions.delete(tabId);
		this.statusSequences.delete(tabId);
		this.sessionStates.set(session.sessionId, "inactive");
		this.persistViewState();
		this.postHistory();
		// Pi owns the session tab's lifetime: once it exits there is nothing left to show.
		this.post({ type: "session-close", id: tabId });
		if (exitCode !== 0) void vscode.window.showWarningMessage(`Pi exited with code ${exitCode}.`);
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
			session.title = this.titleForSession(report.sessionId);
			this.postSessionMeta(session);
			this.persistViewState();
		}
		if (report.sessionPath && report.sessionPath !== session.path) {
			session.path = report.sessionPath;
			this.persistViewState();
		}
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
		this.postSessionMeta(session);
	}

	private postSessionMeta(session: RunningSession): void {
		this.post({ type: "session-meta", id: session.tabId, sessionId: session.sessionId, title: session.title });
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
		const archived = new Set(this.viewState.archivedSessionIds);
		const sessions = [...this.history.values()].map(({ id, title, createdAtMs, mtimeMs }) => {
			const openSession = this.openSessionFor(id);
			return {
				id,
				title,
				createdAtMs,
				updatedAtMs: mtimeMs,
				archived: archived.has(id),
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
				updatedAtMs: session.startedAtMs,
				archived: archived.has(session.sessionId),
				tabId: session.tabId,
				state: this.sessionStates.get(session.sessionId) ?? "starting",
			});
		}
		sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
		this.post({ type: "history", sessions });
	}

	private refreshSoon(): void {
		if (this.disposed || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refreshHistory();
		}, 500);
	}

	private postTerminalOptions(): void {
		this.post({
			type: "options",
			options: terminalOptions((section) => vscode.workspace.getConfiguration(section)),
		});
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
	if (
		message.type === "ready" ||
		message.type === "refresh" ||
		message.type === "new" ||
		message.type === "close-view" ||
		message.type === "customize"
	) {
		return true;
	}
	if (message.type === "input") return typeof message.id === "string" && typeof message.data === "string";
	if (message.type === "resize") {
		return typeof message.id === "string" && typeof message.cols === "number" && typeof message.rows === "number";
	}
	if (message.type === "archive") return typeof message.id === "string" && typeof message.archived === "boolean";
	if (message.type === "detach" || message.type === "shutdown" || message.type === "delete" || message.type === "focus") {
		return typeof message.id === "string";
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
				<div id="tabbar-actions">
					<button id="new-tab" class="icon-button" type="button" title="New session" aria-label="New session"></button>
					<button id="tab-menu" class="icon-button" type="button" title="More actions" aria-label="More actions" aria-haspopup="menu"></button>
					<button id="show-sidebar" class="icon-button" type="button" title="Show sessions" aria-label="Show sessions" hidden></button>
				</div>
			</div>
			<div id="terminal-body">
				<div id="terminal-hosts"></div>
				<div id="find" hidden>
					<input id="find-input" type="text" placeholder="Find" aria-label="Find in terminal" autocomplete="off" spellcheck="false">
					<span id="find-count" aria-live="polite">No results</span>
					<button id="find-prev" class="icon-button" type="button" title="Previous match (Shift+Enter)" aria-label="Previous match"></button>
					<button id="find-next" class="icon-button" type="button" title="Next match (Enter)" aria-label="Next match"></button>
					<button id="find-close" class="icon-button" type="button" title="Close (Escape)" aria-label="Close find"></button>
				</div>
				<div id="empty-state" hidden>
					<p class="empty-title">No open session</p>
					<p class="empty-hint">Start a new session, or pick one from the list.</p>
					<button id="empty-new" class="primary-button" type="button">New session</button>
				</div>
			</div>
		</main>
		<aside id="sidebar" aria-label="Pi sessions">
			<div id="sidebar-header">
				<button id="customize" class="icon-button" type="button" title="Customize Pi settings" aria-label="Customize Pi settings"></button>
				<button id="refresh" class="icon-button" type="button" title="Refresh sessions" aria-label="Refresh sessions"></button>
				<button id="hide-sidebar" class="icon-button" type="button" title="Hide sessions" aria-label="Hide sessions"></button>
			</div>
			<div id="search-field">
				<span class="search-icon" aria-hidden="true"></span>
				<input id="search" type="text" placeholder="Search sessions..." aria-label="Search sessions" autocomplete="off" spellcheck="false">
			</div>
			<nav id="sidebar-actions" aria-label="Session actions">
				<button id="new-session" class="sidebar-action" type="button">
					<span class="action-label">New session</span>
				</button>
			</nav>
			<div id="session-list"></div>
		</aside>
	</div>
	<div id="menu" role="menu" hidden></div>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "xterm", "lib", "xterm.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-web-links", "lib", "addon-web-links.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-webgl", "lib", "addon-webgl.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-unicode11", "lib", "addon-unicode11.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-search", "lib", "addon-search.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "wrapped-path-links.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "clipboard.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "session-view.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "main.js")}"></script>
</body>
</html>`;
}
