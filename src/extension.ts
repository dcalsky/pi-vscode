import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, promises as fs, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as pty from "node-pty";
import * as vscode from "vscode";
import {
	createForkedSession,
	createNativeDraftFile,
	listSessionUserMessages,
	prepareRewindSession,
	removeNativeDraftFile,
	resolveSessionSnapshot,
	restoreWorktreeSnapshot,
	rewriteSessionFile,
	worktreeDiffersFromSnapshot,
} from "./session-actions";
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
	type PiPanelRequest,
	type PiSessionState,
	type PiStatusReport,
} from "./status-bridge";
import { win32Spawn } from "./pi-command";
import { httpUrl, resolveFileLink } from "./terminal-links";
import { normalizeViewState, setArchived, type PiViewState } from "./view-state";
import { terminalOptions } from "./xterm-options";

interface RunningSession {
	tabId: string;
	sessionId: string;
	startedAtMs: number;
	title: string;
	path?: string;
	leafId?: string;
	/** False once its tab is closed: Pi keeps running, but the tab is not restored. */
	attached: boolean;
	process: pty.IPty;
}

interface StartSessionOptions {
	draftFile?: string;
	nativeDraftFile?: string;
	reportError?: boolean;
	/** Agent-created panels open in the background without stealing focus. */
	noFocus?: boolean;
	/** Passed to `pi --model` for agent-created panels. */
	model?: string;
}

interface PanelWaiter {
	tabId: string;
	resolve: () => void;
}

type SessionHistoryAction = "fork" | "rewind";

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
	| { type: "load-user-messages"; action: SessionHistoryAction; id: string; requestId: string }
	| { type: "session-history-action"; action: SessionHistoryAction; id: string; entryId?: string }
	| { type: "open-link"; kind: "file" | "url"; target: string };

const PI_VIEW_ID = "piAgent.view";
const PI_CONTAINER_COMMAND = "workbench.view.extension.piAgent";
const PI_CLOSE_SESSION_OR_VIEW_COMMAND = "piAgent.closeSessionOrView";
const PI_VIEW_STATE_KEY = "piAgent.viewState";
const PI_FORK_DRAFT_FILE_ENV = "PI_VSCODE_FORK_DRAFT_FILE";
const PI_NATIVE_DRAFT_FILE_ENV = "PI_VSCODE_DRAFT_FILE";
const SESSION_ACTION_DISABLED_MESSAGE = "Available until session is done";
const DEFAULT_PI_COMMAND = "pi";
/** Like herdr's agent prompt stall check: a prompted panel must show activity within this window. */
const PANEL_STALL_MS = 15_000;
const PANEL_READY_TIMEOUT_MS = 30_000;
const DEFAULT_PANEL_WAIT_TIMEOUT_MS = 30 * 60_000;
const MAX_PANEL_WAIT_TIMEOUT_MS = 2 * 3_600_000;
let ptyPrepared = false;
let piViewProvider: PiViewProvider | undefined;
/** Command resolved by auto-detection; used until the user sets piAgent.command explicitly. */
let resolvedPiCommand: string | undefined;

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
	private readonly tabStates = new Map<string, { state: PiSessionState; changedAtMs: number }>();
	private readonly panelWaiters = new Set<PanelWaiter>();
	private readonly replacingProcesses = new Set<pty.IPty>();
	private readonly sessionActions = new Set<string>();
	private readonly messageQueue: object[] = [];
	private readonly pendingStarts: Array<{ id: string; sessionPath?: string; options?: StartSessionOptions }> = [];
	private readonly statusBridge: PiStatusBridge;
	private viewState: PiViewState;
	private refreshTimer: NodeJS.Timeout | undefined;
	private recoveringStart = false;
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
			(request) => this.handlePanelRequest(request),
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
		this.postCloseBehavior();
		vscode.workspace.onDidChangeConfiguration(
			(event) => {
				if (event.affectsConfiguration("terminal.integrated") || event.affectsConfiguration("editor")) {
					this.postTerminalOptions();
				}
				if (event.affectsConfiguration("piAgent.closeBehavior")) this.postCloseBehavior();
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
		for (const waiter of [...this.panelWaiters]) waiter.resolve();
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
			case "load-user-messages":
				await this.loadUserMessages(message.action, message.id, message.requestId);
				break;
			case "session-history-action":
				await this.runSessionHistoryAction(message.action, message.id, message.entryId);
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
		this.noteTabState(tabId, "inactive");
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

	// Archiving only files the session under Archive; the webview closes its tab, Pi keeps running.
	private archiveSession(sessionId: string, archived: boolean): void {
		this.viewState = setArchived(this.viewState, sessionId, archived);
		this.persistViewState();
		this.postHistory();
	}

	private async loadUserMessages(action: SessionHistoryAction, sessionId: string, requestId: string): Promise<void> {
		try {
			const source = this.sessionActionSource(sessionId);
			this.assertSessionActionAvailable(source.open);
			const messages = await listSessionUserMessages(source.path, source.open?.leafId);
			this.post({ type: "user-messages", action, sessionId, requestId, messages });
		} catch (error) {
			this.post({ type: "user-messages", action, sessionId, requestId, error: errorMessage(error), messages: [] });
		}
	}

	private async runSessionHistoryAction(
		action: SessionHistoryAction,
		sessionId: string,
		entryId?: string,
	): Promise<void> {
		if (this.sessionActions.has(sessionId)) return;
		this.sessionActions.add(sessionId);
		try {
			if (action === "fork") await this.forkSession(sessionId, entryId);
			else await this.rewindSessionToMessage(sessionId, entryId!);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not ${action} session: ${errorMessage(error)}`);
		} finally {
			this.sessionActions.delete(sessionId);
		}
	}

	private async forkSession(sessionId: string, entryId?: string): Promise<void> {
		const source = this.sessionActionSource(sessionId);
		this.assertSessionActionAvailable(source.open);
		let forked: Awaited<ReturnType<typeof createForkedSession>> | undefined;
		let draftFile: string | undefined;
		try {
			forked = await createForkedSession(source.path, entryId, source.title, source.open?.leafId);
			if (forked.draft) draftFile = await createNativeDraftFile(forked.draft);
			await this.refreshHistory();
			const failure = this.startSession(forked.id, forked.path, { nativeDraftFile: draftFile, reportError: false });
			if (failure) throw new Error(failure);
		} catch (error) {
			if (draftFile) await removeNativeDraftFile(draftFile).catch(() => undefined);
			if (forked) await deleteSessionFiles(forked.path).catch(() => undefined);
			await this.refreshHistory();
			throw error;
		}
	}

	private async rewindSessionToMessage(sessionId: string, entryId: string): Promise<void> {
		let source = this.sessionActionSource(sessionId);
		this.assertSessionActionAvailable(source.open);
		let prepared = await prepareRewindSession(source.path, entryId, source.title, source.open?.leafId);
		const snapshot = await resolveSessionSnapshot(source.path, entryId);
		let revertCode = false;
		if (snapshot && (await worktreeDiffersFromSnapshot(this.cwd, snapshot))) {
			const choice = await vscode.window.showWarningMessage(
				"Submit from a previous message?",
				{
					modal: true,
					detail: "Submitting from a previous message will revert file changes to before this message and clear the messages after this one.",
				},
				"Don't Revert",
				"Revert",
			);
			if (!choice || this.disposed) return;
			revertCode = choice === "Revert";
		}

		// The user can submit from the terminal while the confirmation is open. Re-read
		// and re-check immediately before stopping or rewriting the session.
		source = this.sessionActionSource(sessionId);
		this.assertSessionActionAvailable(source.open);
		prepared = await prepareRewindSession(source.path, entryId, source.title, source.open?.leafId);
		const originalContents = await fs.readFile(source.path, "utf8");
		const draftFile = await createNativeDraftFile(prepared.draft);
		const tabId = source.open?.tabId ?? sessionId;
		let stopped = false;
		let rewritten = false;
		try {
			if (source.open) {
				await this.stopSessionForReplacement(source.open);
				stopped = true;
			}
			if (revertCode && snapshot) await restoreWorktreeSnapshot(this.cwd, snapshot);
			await rewriteSessionFile(source.path, prepared.contents);
			rewritten = true;
			await this.refreshHistory();
			const failure = this.startSession(tabId, source.path, { nativeDraftFile: draftFile, reportError: false });
			if (failure) throw new Error(failure);
		} catch (error) {
			await removeNativeDraftFile(draftFile).catch(() => undefined);
			if (rewritten) await rewriteSessionFile(source.path, originalContents).catch(() => undefined);
			const current = this.sessions.get(tabId);
			if (stopped && (!current || current.process === source.open?.process)) {
				this.startSession(tabId, source.path, { reportError: false });
			} else if (!stopped && current?.process === source.open?.process) {
				this.sessionStates.set(sessionId, "idle");
				this.postHistory();
			}
			await this.refreshHistory();
			throw error;
		}
	}

	private sessionActionSource(sessionId: string): {
		path: string;
		title: string;
		open: RunningSession | undefined;
	} {
		const open = this.openSessionFor(sessionId);
		const saved = this.history.get(sessionId);
		const path = saved?.path ?? open?.path;
		if (!path) throw new Error("Send a message before using this action.");
		return { path, title: saved?.title ?? open?.title ?? NEW_SESSION_TITLE, open };
	}

	private assertSessionActionAvailable(open: RunningSession | undefined): void {
		if (!open || this.sessionStates.get(open.sessionId) === "idle") return;
		throw new Error(SESSION_ACTION_DISABLED_MESSAGE);
	}

	private async stopSessionForReplacement(session: RunningSession): Promise<void> {
		const process = session.process;
		this.replacingProcesses.add(process);
		this.sessionStates.set(session.sessionId, "starting");
		this.postHistory();
		await new Promise<void>((resolvePromise, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let listener: pty.IDisposable | undefined;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				listener?.dispose();
				this.replacingProcesses.delete(process);
				if (error) reject(error);
				else resolvePromise();
			};
			listener = process.onExit(() => finish());
			timer = setTimeout(() => finish(new Error("Timed out while stopping the Pi session.")), 5_000);
			try {
				process.kill();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
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

	private async handlePanelRequest(request: PiPanelRequest): Promise<unknown> {
		switch (request.action) {
			case "create":
				return this.panelCreate(request.model);
			case "prompt":
				return this.panelPrompt(request.tabId, request.text);
			case "wait":
				return request.tabIds
					? this.panelWaitAll(request.tabIds, request.sinceMs, request.timeoutMs)
					: this.panelWait(request.tabId, request.sinceMs, request.timeoutMs);
			case "list":
				return this.panelList();
		}
	}

	/** Like `herdr agent start`: open a background tab and answer once its Pi accepts input. */
	private async panelCreate(model: string | undefined): Promise<{ tabId: string; sessionId: string }> {
		const id = randomUUID();
		const failure = this.startSession(id, undefined, { noFocus: true, reportError: false, model });
		if (failure) throw new Error(failure);
		const deadline = Date.now() + PANEL_READY_TIMEOUT_MS;
		for (;;) {
			if (this.disposed) throw new Error("The Pi view is closed");
			const current = this.tabStates.get(id);
			if (current && (current.state === "idle" || current.state === "working")) {
				return { tabId: id, sessionId: id };
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`Panel ${id} did not become ready within ${PANEL_READY_TIMEOUT_MS / 1000}s`);
			await Promise.race([this.waitForTabChange(id), sleep(remaining)]);
		}
	}

	/** Bracketed paste keeps newlines literal in Pi's editor; Enter submits after the paste closes. */
	private async panelPrompt(tabId: string | undefined, text: string | undefined): Promise<{ tabId: string; promptedAtMs: number }> {
		if (!tabId || !text) throw new Error("panel prompt requires tabId and text");
		const session = this.sessions.get(tabId);
		if (!session) throw new Error(`No open panel ${tabId}`);
		session.process.write(`\x1b[200~${text}\x1b[201~`);
		await sleep(100);
		session.process.write("\r");
		return { tabId, promptedAtMs: Date.now() };
	}

	private async panelWait(
		tabId: string | undefined,
		sinceMs: number | undefined,
		timeoutMs: number | undefined,
	): Promise<{ tabId: string; state: PiSessionState; settled: boolean }> {
		if (!tabId) throw new Error("panel wait requires a tabId");
		const result = await this.panelWaitAll([tabId], sinceMs, timeoutMs);
		const panel = result.panels[0];
		return { tabId, state: panel.state, settled: panel.settled };
	}

	/** Fan-in wait: resolves when every listed panel settles (idle after sinceMs, or exits). */
	private async panelWaitAll(
		tabIds: string[],
		sinceMs: number | undefined,
		timeoutMs: number | undefined,
	): Promise<{ settled: boolean; panels: Array<{ tabId: string; state: PiSessionState; settled: boolean }> }> {
		for (const tabId of tabIds) {
			if (!this.sessions.has(tabId) && this.tabStates.get(tabId)?.state !== "inactive") {
				throw new Error(`No open panel ${tabId}`);
			}
		}
		const timeout = clamp(Math.round(timeoutMs ?? DEFAULT_PANEL_WAIT_TIMEOUT_MS), 1_000, MAX_PANEL_WAIT_TIMEOUT_MS);
		const deadline = Date.now() + timeout;
		const stallDeadline = sinceMs === undefined ? undefined : sinceMs + PANEL_STALL_MS;
		for (;;) {
			if (this.disposed) {
				return { settled: false, panels: tabIds.map((tabId) => ({ tabId, state: "inactive", settled: false })) };
			}
			const now = Date.now();
			const panels = tabIds.map((tabId) => {
				const current = this.tabStates.get(tabId);
				const state = current?.state ?? "starting";
				const settled =
					(state === "idle" || state === "inactive") &&
					(sinceMs === undefined || (current !== undefined && current.changedAtMs >= sinceMs));
				if (
					stallDeadline !== undefined &&
					now >= stallDeadline &&
					state === "idle" &&
					current !== undefined &&
					current.changedAtMs < sinceMs!
				) {
					throw new Error(
						`Panel ${tabId} showed no activity within ${PANEL_STALL_MS / 1000}s of the prompt; ` +
							"it may be busy or showing a dialog. Inspect the panel before retrying.",
					);
				}
				return { tabId, state, settled };
			});
			if (panels.every((panel) => panel.settled)) return { settled: true, panels };
			const remaining = deadline - now;
			if (remaining <= 0) return { settled: false, panels };
			await Promise.race([...tabIds.map((tabId) => this.waitForTabChange(tabId)), sleep(remaining)]);
		}
	}

	private panelList(): Array<{ tabId: string; sessionId: string; title: string; state: PiSessionState }> {
		return [...this.sessions.values()].map((session) => ({
			tabId: session.tabId,
			sessionId: session.sessionId,
			title: session.title,
			state: this.tabStates.get(session.tabId)?.state ?? "starting",
		}));
	}

	private noteTabState(tabId: string, state: PiSessionState): void {
		if (this.tabStates.get(tabId)?.state === state) return;
		this.tabStates.set(tabId, { state, changedAtMs: Date.now() });
		for (const waiter of [...this.panelWaiters]) {
			if (waiter.tabId === tabId) waiter.resolve();
		}
	}

	private waitForTabChange(tabId: string): Promise<void> {
		return new Promise((resolve) => {
			const waiter: PanelWaiter = {
				tabId,
				resolve: () => {
					this.panelWaiters.delete(waiter);
					resolve();
				},
			};
			this.panelWaiters.add(waiter);
		});
	}

	private startSession(id: string, sessionPath?: string, options: StartSessionOptions = {}): string | undefined {
		if (!this.statusBridgeReady) {
			this.pendingStarts.push({ id, sessionPath, options });
			return undefined;
		}
		const command = vscode.workspace.getConfiguration("piAgent").get<string>("command", DEFAULT_PI_COMMAND).trim();
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
			if (options.model) args.push("--model", options.model);
			if (this.statusBridge.isListening) args.push("--extension", piStatusExtensionPath(this.extensionUri));
			const draftEnvironment = options.nativeDraftFile
				? { [PI_NATIVE_DRAFT_FILE_ENV]: options.nativeDraftFile }
				: options.draftFile
					? { [PI_FORK_DRAFT_FILE_ENV]: options.draftFile }
					: {};
			const file = effectivePiCommand(command);
			const spawn = process.platform === "win32" ? win32Spawn(file, args) : { file, args };
			const child = pty.spawn(spawn.file, spawn.args, {
				cwd: this.cwd,
				name: "xterm-256color",
				cols: this.cols,
				rows: this.rows,
				env: { ...terminalEnvironment(), ...this.statusBridge.environmentFor(tabId), ...draftEnvironment },
			});
			spawnedProcess = child;
			const title = this.titleForSession(id);
			const session: RunningSession = {
				tabId,
				sessionId: id,
				startedAtMs: Date.now(),
				title,
				path: sessionPath,
				attached: true,
				process: child,
			};
			this.sessions.set(tabId, session);
			this.statusSequences.delete(tabId);
			this.sessionStates.set(id, "starting");
			this.noteTabState(tabId, "starting");
			child.onData((data) => {
				this.post({ type: "data", id: tabId, data });
				this.refreshSoon();
			});
			child.onExit(({ exitCode }) => this.handleExit(tabId, child, exitCode));
			this.post({ type: "session-open", id: tabId, sessionId: id, title, noFocus: options.noFocus === true });
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
			if (options.reportError !== false) {
				// Auto-detect pi (PATH, npm global dir) and restart; only prompt when that fails.
				void this.recoverStart(id, sessionPath, options, failure);
			}
			return failure;
		}
	}

	/**
	 * A session failed to spawn. Try to locate pi automatically; if that fails, ask the user
	 * for its executable (browse or type) and restart with it saved to piAgent.command.
	 */
	private async recoverStart(
		id: string,
		sessionPath: string | undefined,
		options: StartSessionOptions,
		failure: string,
	): Promise<void> {
		if (this.disposed || this.recoveringStart) return;
		this.recoveringStart = true;
		try {
			const configured = vscode.workspace.getConfiguration("piAgent").get<string>("command", DEFAULT_PI_COMMAND).trim();
			// Only auto-detect the default bare name; an explicit path is the user's own choice.
			if (configured === DEFAULT_PI_COMMAND && !resolvedPiCommand) {
				const found = await detectPiCommand();
				if (found && !this.disposed) {
					resolvedPiCommand = found;
					const retry = this.startSession(id, sessionPath, { ...options, reportError: false });
					if (!retry) return;
					failure = retry;
				}
			}
			await this.promptForPiLocation(id, sessionPath, options, failure);
		} finally {
			this.recoveringStart = false;
		}
	}

	private async promptForPiLocation(
		id: string,
		sessionPath: string | undefined,
		options: StartSessionOptions,
		failure: string,
	): Promise<void> {
		if (this.disposed) return;
		const action = await vscode.window.showErrorMessage(
			`${failure}\nInstall pi with \"npm install -g @earendil-works/pi-coding-agent\" (Git Bash is required on Windows), or point to an existing executable.`,
			"Locate pi...",
			"Install pi",
		);
		if (!action || this.disposed) return;
		if (action === "Install pi") {
			await vscode.env.openExternal(vscode.Uri.parse("https://pi.dev"));
			return;
		}

		const browse = "Browse for the pi executable";
		const manual = "Enter the path manually";
		const method = await vscode.window.showQuickPick(
			[
				{ label: browse, detail: "Open a file picker and select the pi executable" },
				{ label: manual, detail: "Type the absolute path to the pi executable" },
			],
			{ placeHolder: "How do you want to provide the pi executable?" },
		);
		let chosen: string | undefined;
		if (method?.label === browse) {
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectMany: false,
				openLabel: "Select pi executable",
				title: "Select the pi executable",
			});
			chosen = picked?.[0]?.fsPath;
		} else if (method?.label === manual) {
			chosen = await vscode.window.showInputBox({
				prompt: "Absolute path to the pi executable",
				placeHolder:
					process.platform === "win32" ? "C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd" : "/usr/local/bin/pi",
				validateInput: (value) => {
					const path = value.trim();
					if (!path) return "Enter a path";
					return existsSync(path) ? undefined : "File not found";
				},
			});
		}
		const path = chosen?.trim();
		if (!path || this.disposed) return;
		await vscode.workspace.getConfiguration("piAgent").update("piAgent.command", path, vscode.ConfigurationTarget.Global);
		resolvedPiCommand = undefined;
		const retry = this.startSession(id, sessionPath, { ...options, reportError: false });
		if (retry) void vscode.window.showErrorMessage(retry);
	}

	private handleExit(tabId: string, process: pty.IPty, exitCode: number): void {
		if (this.replacingProcesses.has(process)) return;
		const session = this.sessions.get(tabId);
		if (this.disposed || session?.process !== process) return;
		this.sessions.delete(tabId);
		this.statusSequences.delete(tabId);
		this.sessionStates.set(session.sessionId, "inactive");
		this.noteTabState(tabId, "inactive");
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
		session.leafId = report.leafId;
		this.sessionStates.set(report.sessionId, report.state);
		this.noteTabState(report.tabId, report.state);
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

	private postCloseBehavior(): void {
		const stop = vscode.workspace.getConfiguration("piAgent").get<string>("closeBehavior", "detach") === "stop";
		this.post({ type: "close-behavior", stop });
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalEnvironment(): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

/** An explicit piAgent.command wins; the auto-detected path only fills in the default. */
function effectivePiCommand(configured: string): string {
	return configured === DEFAULT_PI_COMMAND ? (resolvedPiCommand ?? configured) : configured;
}

async function detectPiCommand(): Promise<string | undefined> {
	return process.platform === "win32" ? detectPiCommandWindows() : detectPiCommandUnix();
}

async function detectPiCommandWindows(): Promise<string | undefined> {
	const where = await runCapture("cmd.exe", ["/d", "/s", "/c", "where pi"]);
	for (const line of where.split(/\r?\n/)) {
		const hit = line.trim();
		if (hit && existsSync(hit)) return hit;
	}
	// npm's global dir may be missing from a GUI-launched VS Code PATH (nvm, fnm, custom prefix).
	const appData = process.env.APPDATA;
	const npmShim = appData ? join(appData, "npm", "pi.cmd") : undefined;
	return npmShim && existsSync(npmShim) ? npmShim : undefined;
}

async function detectPiCommandUnix(): Promise<string | undefined> {
	const which = await runCapture("which", ["pi"]);
	for (const line of which.split("\n")) {
		const hit = line.trim();
		if (hit && existsSync(hit)) return hit;
	}
	// GUI-launched VS Code may miss shell-profile PATH entries (Homebrew, custom npm prefix).
	for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".bun", "bin")]) {
		const candidate = join(dir, "pi");
		if (isExecutableFile(candidate)) return candidate;
	}
	return undefined;
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function runCapture(file: string, args: string[], timeoutMs = 5_000): Promise<string> {
	return new Promise((resolvePromise) => {
		execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
			resolvePromise(error ? "" : stdout);
		});
	});
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
	if (message.type === "load-user-messages") {
		return (
			isSessionHistoryAction(message.action) &&
			nonEmptyBoundedString(message.id, 512) &&
			nonEmptyBoundedString(message.requestId, 512)
		);
	}
	if (message.type === "session-history-action") {
		return (
			isSessionHistoryAction(message.action) &&
			nonEmptyBoundedString(message.id, 512) &&
			(message.entryId === undefined || nonEmptyBoundedString(message.entryId, 512)) &&
			(message.action !== "rewind" || nonEmptyBoundedString(message.entryId, 512))
		);
	}
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

function isSessionHistoryAction(value: unknown): value is SessionHistoryAction {
	return value === "fork" || value === "rewind";
}

function nonEmptyBoundedString(value: unknown, maximumLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
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
	<div id="message-dialog" class="dialog-scrim" hidden>
		<section class="message-dialog-card" role="dialog" aria-modal="true" aria-labelledby="message-dialog-title" aria-describedby="message-dialog-description">
			<header class="message-dialog-header">
				<h2 id="message-dialog-title"></h2>
				<p id="message-dialog-description"></p>
			</header>
			<div id="message-dialog-list" class="message-dialog-list" role="radiogroup" aria-label="User messages"></div>
			<footer class="message-dialog-footer">
				<button id="message-dialog-cancel" class="dialog-button" type="button">Cancel</button>
				<button id="message-dialog-submit" class="dialog-button primary" type="button" disabled></button>
			</footer>
		</section>
	</div>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "xterm", "lib", "xterm.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-web-links", "lib", "addon-web-links.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-webgl", "lib", "addon-webgl.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-unicode11", "lib", "addon-unicode11.js")}"></script>
	<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-search", "lib", "addon-search.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "wrapped-path-links.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "clipboard.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "ime.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "session-view.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "main.js")}"></script>
</body>
</html>`;
}
