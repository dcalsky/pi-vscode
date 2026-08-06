(() => {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	const tabs = document.getElementById("tabs");
	const hosts = document.getElementById("terminal-hosts");
	const emptyState = document.getElementById("empty-state");
	const emptyNew = document.getElementById("empty-new");
	const sidebar = document.getElementById("sidebar");
	const sessionList = document.getElementById("session-list");
	const search = document.getElementById("search");
	const refresh = document.getElementById("refresh");
	const newSession = document.getElementById("new-session");
	const customize = document.getElementById("customize");
	const newTab = document.getElementById("new-tab");
	const tabMenu = document.getElementById("tab-menu");
	const hideSidebar = document.getElementById("hide-sidebar");
	const showSidebar = document.getElementById("show-sidebar");
	const menu = document.getElementById("menu");
	const find = document.getElementById("find");
	const findInput = document.getElementById("find-input");
	const findCount = document.getElementById("find-count");
	const findPrev = document.getElementById("find-prev");
	const findNext = document.getElementById("find-next");
	const findClose = document.getElementById("find-close");
	const messageDialog = document.getElementById("message-dialog");
	const messageDialogTitle = document.getElementById("message-dialog-title");
	const messageDialogDescription = document.getElementById("message-dialog-description");
	const messageDialogList = document.getElementById("message-dialog-list");
	const messageDialogCancel = document.getElementById("message-dialog-cancel");
	const messageDialogSubmit = document.getElementById("message-dialog-submit");

	const terminals = new Map();
	const expandedGroups = new Set();
	const collapsedGroups = new Set();
	const GROUP_PREVIEW_COUNT = 6;
	const STOP_LABEL = "Stop Pi";
	const DELETE_HINT = "Stop Pi and delete this session from disk";
	const SESSION_ACTION_DISABLED_HINT = "Available until session is done";
	let activeId;
	let historySessions = [];
	let closeBehaviorStop = false;
	let messageDialogState;
	let messageRequestSequence = 0;

	const statusLabels = {
		inactive: "Not open",
		starting: "Starting",
		working: "Working",
		idle: "Idle",
	};
	const statusIcons = {
		inactive: "check-circle",
		starting: "spinner",
		working: "spinner",
		idle: "check-circle",
	};

	const SVG_ATTRIBUTES =
		'viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
	const ICON_PATHS = {
		plus: '<path d="M8 3.4v9.2M3.4 8h9.2"/>',
		ellipsis:
			'<circle cx="3.4" cy="8" r="1.05" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.05" fill="currentColor" stroke="none"/><circle cx="12.6" cy="8" r="1.05" fill="currentColor" stroke="none"/>',
		sidebar: '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6"/><path d="M10.2 2.6v10.8"/>',
		search: '<circle cx="6.9" cy="6.9" r="4.1"/><path d="M10 10 13.6 13.6"/>',
		archive:
			'<rect x="1.8" y="2.8" width="12.4" height="3.1" rx="1"/><path d="M3.2 6.1v6.1a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V6.1"/><path d="M6.4 9h3.2"/>',
		unarchive:
			'<rect x="1.8" y="2.8" width="12.4" height="3.1" rx="1"/><path d="M3.2 6.1v6.1a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V6.1"/><path d="M8 12.1V8.1m0 0L6.4 9.7M8 8.1l1.6 1.6"/>',
		"check-circle": '<circle cx="8" cy="8" r="5.7"/><path d="M5.6 8.2 7.2 9.8l3.2-3.6"/>',
		spinner: '<circle cx="8" cy="8" r="5.7" stroke-opacity="0.3"/><path d="M8 2.3a5.7 5.7 0 0 1 5.7 5.7"/>',
		sliders: '<path d="M2.6 5.2h10.8M2.6 10.8h10.8"/><circle cx="6" cy="5.2" r="1.6"/><circle cx="10.4" cy="10.8" r="1.6"/>',
		refresh: '<path d="M13.3 8a5.3 5.3 0 1 1-1.6-3.8"/><path d="M13.5 2.7v3.2h-3.2"/>',
		close: '<path d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6"/>',
		"chevron-down": '<path d="M4.2 6.4 8 10.1l3.8-3.7"/>',
		"chevron-up": '<path d="M4.2 9.6 8 5.9l3.8 3.7"/>',
		"chevron-right": '<path d="M6.4 4.2 10.1 8l-3.7 3.8"/>',
	};

	function icon(name, className) {
		const wrapper = document.createElement("span");
		wrapper.className = className ? `icon ${className}` : "icon";
		wrapper.setAttribute("aria-hidden", "true");
		wrapper.innerHTML = `<svg ${SVG_ATTRIBUTES}>${ICON_PATHS[name] || ""}</svg>`;
		return wrapper;
	}

	function color(name, fallback) {
		return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
	}

	// Both panes share the side bar surface so the divider between them stays readable in
	// themes whose editor background is lighter than the side bar.
	function paneBackground() {
		return color("--vscode-sideBar-background", color("--vscode-editor-background", "#1e1e1e"));
	}

	// The palette VS Code's own terminal uses, read from the theme colors the webview exposes as CSS
	// variables. Without this xterm falls back to its built-in ANSI colors and Pi's output looks
	// nothing like the integrated terminal.
	const ANSI_NAMES = [
		"black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
		"brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
	];

	function xtermTheme() {
		const foreground = color("--vscode-terminal-foreground", color("--vscode-foreground", "#cccccc"));
		const background = paneBackground();
		const theme = {
			background,
			foreground,
			cursor: color("--vscode-terminalCursor-foreground", foreground),
			cursorAccent: color("--vscode-terminalCursor-background", background),
			selectionBackground: color("--vscode-terminal-selectionBackground", "#264f78"),
			selectionInactiveBackground: color("--vscode-terminal-inactiveSelectionBackground", "") || undefined,
			selectionForeground: color("--vscode-terminal-selectionForeground", "") || undefined,
			scrollbarSliderBackground: color("--vscode-scrollbarSlider-background", "") || undefined,
			scrollbarSliderHoverBackground: color("--vscode-scrollbarSlider-hoverBackground", "") || undefined,
			scrollbarSliderActiveBackground: color("--vscode-scrollbarSlider-activeBackground", "") || undefined,
			// The overview ruler (find-decoration strip next to the scrollbar) draws its 1px
			// outline in overviewRulerBorder; unset it defaults to the bright foreground, which
			// reads as an ugly border on the scrollbar. Paint it in the pane background to hide it.
			overviewRulerBorder: background,
		};
		for (const name of ANSI_NAMES) {
			const value = color(`--vscode-terminal-ansi${name[0].toUpperCase()}${name.slice(1)}`, "");
			if (value) theme[name] = value;
		}
		return theme;
	}

	// Sent by the extension from terminal.integrated.* / editor.*; see src/xterm-options.ts.
	let options = { xterm: {}, gpuAcceleration: "auto", unicodeVersion: "11", copyOnSelection: false, kittyKeyboard: true };

	function applyOptions(term) {
		// Assign key by key: a few options are constructor-only and xterm throws on those.
		for (const [key, value] of Object.entries({ ...options.xterm, theme: xtermTheme() })) {
			try {
				term.options[key] = value;
			} catch {
				// Option not settable at runtime; it was applied at construction.
			}
		}
		if (term.unicode) term.unicode.activeVersion = options.unicodeVersion;
	}

	function loadRenderer(term) {
		if (options.gpuAcceleration === "off" || typeof WebglAddon === "undefined") return;
		try {
			const webgl = new WebglAddon.WebglAddon();
			// Losing the GL context leaves a blank canvas, so drop back to the DOM renderer.
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// No WebGL2 here; xterm keeps its DOM renderer.
		}
	}

	let soundContext;

	function unlockSound() {
		const AudioContext = window.AudioContext || window.webkitAudioContext;
		if (!AudioContext) return;
		const context = (soundContext ??= new AudioContext());
		if (context.state !== "running") void context.resume().catch(() => undefined);
	}

	function playAttentionSound() {
		unlockSound();
		const context = soundContext;
		if (!context || context.state !== "running") return;
		const oscillator = context.createOscillator();
		const gain = context.createGain();
		const now = context.currentTime;
		oscillator.frequency.setValueAtTime(880, now);
		gain.gain.setValueAtTime(0.0001, now);
		gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
		oscillator.connect(gain).connect(context.destination);
		oscillator.start(now);
		oscillator.stop(now + 0.2);
	}

	function openLink(event, kind, target) {
		if (event.button !== 0 || (!event.metaKey && !event.ctrlKey)) return;
		event.preventDefault();
		vscode.postMessage({ type: "open-link", kind, target });
	}

	function registerTerminalLinks(term) {
		// The unified provider must run first because Pi's renderer emits hard-wrapped
		// URLs as separate PTY rows; a per-row URL provider would otherwise shadow the
		// reconstructed full range with its first fragment.
		term.registerLinkProvider(
			WrappedPathLinks.createPathLinkProvider(term, (event, target, kind) => openLink(event, kind, target)),
		);
		term.loadAddon(new WebLinksAddon.WebLinksAddon((event, target) => openLink(event, "url", target)));
	}

	function sendSize(id) {
		const entry = terminals.get(id);
		if (!entry || entry.host.hidden) return;
		entry.fit.fit();
		vscode.postMessage({ type: "resize", id, cols: entry.term.cols, rows: entry.term.rows });
	}

	function openTerminal(id, sessionId, title) {
		let entry = terminals.get(id);
		if (!entry) {
			// xterm measures its host on open, so the pane has to be laid out first.
			hosts.hidden = false;
			const host = document.createElement("div");
			host.className = "terminal-host";
			host.hidden = true;
			hosts.append(host);

			const term = new Terminal({ ...options.xterm, theme: xtermTheme() });
			const fit = new FitAddon.FitAddon();
			term.loadAddon(fit);
			if (typeof Unicode11Addon !== "undefined") {
				term.loadAddon(new Unicode11Addon.Unicode11Addon());
				term.unicode.activeVersion = options.unicodeVersion;
			}
			const search = typeof SearchAddon === "undefined" ? undefined : new SearchAddon.SearchAddon();
			if (search) term.loadAddon(search);
			registerTerminalLinks(term);
			term.open(host);
			loadRenderer(term);
			// Pi hard-wraps Markdown to the terminal width and emits each row as a
			// separate physical line, so xterm's copy would insert newlines at the wrap
			// points. This runs after xterm's own copy handler (registered during open)
			// and rewrites the clipboard with wrap points joined.
			term.element.addEventListener("copy", (event) => {
				if (term.element.classList.contains("column-select")) return;
				const text = WrappedPathLinks.copySelectionText(term);
				if (text !== undefined && event.clipboardData) event.clipboardData.setData("text/plain", text);
			});
			term.onData((data) => vscode.postMessage({ type: "input", id, data }));
			term.onSelectionChange(() => {
				if (!options.copyOnSelection || !term.hasSelection()) return;
				const text = WrappedPathLinks.copySelectionText(term) ?? term.getSelection();
				if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
			});
			// See media/ime.js: unmodified punctuation/digit keydowns go through the browser's
			// native text input so a third-party IME's committed Chinese punctuation lands in
			// xterm's hidden textarea; this capture-phase listener forwards it to the PTY.
			// `pendingNativeInput` is set on the keydown and cancelled by the keypress of a
			// plain ASCII key, which xterm's own _keyPress sends as before, so English typing
			// is unchanged. (xterm's own input listener only forwards insertText when no
			// keydown is in flight, so a commit arriving after keyup is still delivered once.)
			let pendingNativeInput = false;
			term.textarea.addEventListener(
				"input",
				(event) => {
					if (!pendingNativeInput) return;
					pendingNativeInput = false;
					if (event.isComposing || !event.data) return;
					vscode.postMessage({ type: "input", id, data: event.data });
				},
				true,
			);
			term.attachCustomKeyEventHandler((event) => {
				if (event.type !== "keydown") {
					pendingNativeInput = false;
					return true;
				}
				if (PiIme.nativeInputKey(event)) {
					pendingNativeInput = true;
					return false;
				}
				if (isFindShortcut(event)) {
					openFind();
					return false;
				}
				// Cmd+Left/Right on macOS: ^A/^E, Terminal.app style (see media/clipboard.js).
				const arrow = PiClipboard.arrowAction(event);
				if (arrow) {
					vscode.postMessage({ type: "input", id, data: arrow });
					return false;
				}
				// With the Kitty keyboard protocol enabled xterm encodes Shift+Enter itself; without it a
				// bare CR would submit instead of inserting a new line, so send the CSI u sequence pi expects.
				if (options.kittyKeyboard || event.key !== "Enter") return true;
				if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
				vscode.postMessage({ type: "input", id, data: "\x1b[13;2u" });
				return false;
			});
			host.addEventListener("mousedown", () => term.focus());
			entry = { host, term, fit, search, sessionId, title, detached: false };
			terminals.set(id, entry);
		} else {
			entry.sessionId = sessionId;
			entry.title = title;
			entry.detached = false;
			entry.term.reset();
		}
		selectTerminal(id);
	}

	function attachedIds() {
		return [...terminals].filter(([, entry]) => !entry.detached).map(([id]) => id);
	}

	function selectTerminal(id) {
		const selected = terminals.get(id);
		if (!selected) return;
		selected.detached = false;
		hosts.hidden = false;
		closeFind();
		activeId = id;
		for (const [tabId, entry] of terminals) entry.host.hidden = tabId !== id;
		vscode.postMessage({ type: "focus", id });
		render();
		requestAnimationFrame(() => {
			sendSize(id);
			terminals.get(id)?.term.focus();
		});
	}

	function disposeTerminal(id) {
		const entry = terminals.get(id);
		if (!entry) return;
		const index = attachedIds().indexOf(id);
		entry.term.dispose();
		entry.host.remove();
		terminals.delete(id);
		selectNeighbour(id, index);
	}

	// Closing a tab keeps Pi running so the session can be reopened from the list.
	function closeTerminal(id) {
		const entry = terminals.get(id);
		if (!entry || entry.detached) return;
		const index = attachedIds().indexOf(id);
		entry.detached = true;
		entry.host.hidden = true;
		vscode.postMessage({ type: "detach", id });
		selectNeighbour(id, index);
	}

	function shutdownTerminal(id) {
		if (!terminals.has(id)) return;
		vscode.postMessage({ type: "shutdown", id });
	}

	// Tab-close paths follow piAgent.closeBehavior; Archive always detaches.
	function closeTab(id) {
		if (closeBehaviorStop) shutdownTerminal(id);
		else closeTerminal(id);
	}

	function selectNeighbour(closedId, index) {
		if (activeId !== closedId) {
			render();
			return;
		}
		activeId = undefined;
		const remaining = attachedIds();
		const next = remaining[Math.min(index, remaining.length - 1)];
		if (next) selectTerminal(next);
		else render();
	}

	function archiveTerminal(id) {
		const entry = terminals.get(id);
		if (!entry) return;
		setArchived(entry.sessionId, true);
	}

	function setArchived(sessionId, archived) {
		if (!sessionId) return;
		// Archiving closes the session's tab; Pi keeps running and can be resumed from the list.
		if (archived) {
			for (const [id, entry] of terminals) {
				if (entry.sessionId === sessionId) closeTerminal(id);
			}
		}
		vscode.postMessage({ type: "archive", id: sessionId, archived });
	}

	// The extension asks for confirmation, then removes the tab and the list entry.
	function deleteSession(sessionId) {
		if (!sessionId) return;
		vscode.postMessage({ type: "delete", id: sessionId });
	}

	function sessionSummaryForTerminal(id) {
		const entry = terminals.get(id);
		if (!entry) return undefined;
		return (
			historySessions.find((session) => session.id === entry.sessionId) || {
				id: entry.sessionId,
				title: entry.title,
				state: "starting",
			}
		);
	}

	function sessionHistoryActionItems(session) {
		if (!session) return [];
		const available = PiSessionView.sessionActionAvailable(session);
		const hint = available ? undefined : SESSION_ACTION_DISABLED_HINT;
		return [
			{ label: "Fork", hint, disabled: !available, run: () => openMessageDialog("fork", session) },
			{ label: "Rewind", hint, disabled: !available, run: () => openMessageDialog("rewind", session) },
		];
	}

	function openMessageDialog(action, session) {
		if (!PiSessionView.sessionActionAvailable(session)) return;
		const requestId = `messages-${++messageRequestSequence}`;
		messageDialogState = { action, sessionId: session.id, requestId, selectedId: undefined, wholeSession: false, messages: [] };
		messageDialogTitle.textContent = action === "fork" ? "Fork Session" : "Rewind Session";
		messageDialogDescription.textContent =
			action === "fork"
				? `Fork the whole session, or select a user message from “${session.title}”.`
				: `Select a user message from “${session.title}”.`;
		messageDialogSubmit.textContent = action === "fork" ? "Fork" : "Rewind";
		messageDialogSubmit.disabled = true;
		setMessageDialogState("Loading user messages…");
		messageDialog.hidden = false;
		messageDialogCancel.focus();
		vscode.postMessage({ type: "load-user-messages", action, id: session.id, requestId });
	}

	function setMessageDialogState(text, error = false) {
		const state = document.createElement("p");
		state.className = `message-dialog-state${error ? " error" : ""}`;
		state.textContent = text;
		messageDialogList.replaceChildren(state);
	}

	function renderMessageDialogMessages(message) {
		const state = messageDialogState;
		if (!state || state.requestId !== message.requestId || state.sessionId !== message.sessionId || state.action !== message.action) {
			return;
		}
		if (message.error) {
			state.selectedId = undefined;
			state.wholeSession = false;
			messageDialogSubmit.disabled = true;
			setMessageDialogState(message.error, true);
			return;
		}
		state.messages = Array.isArray(message.messages) ? message.messages : [];
		if (!state.messages.length) {
			state.selectedId = undefined;
			state.wholeSession = false;
			messageDialogSubmit.disabled = true;
			setMessageDialogState("No user messages are available in this session.");
			return;
		}
		if (!state.messages.some((entry) => entry.id === state.selectedId)) {
			state.selectedId = state.messages.at(-1)?.id;
		}
		messageDialogList.replaceChildren();
		if (state.action === "fork") {
			messageDialogList.append(messageDialogOption(state, { wholeSession: true, text: "Whole Session" }));
		}
		for (const entry of state.messages) {
			messageDialogList.append(messageDialogOption(state, { entryId: entry.id, text: entry.text }));
		}
		messageDialogSubmit.disabled = !state.selectedId && !state.wholeSession;
		const selectedOption = messageDialogList.querySelector(".message-option.selected");
		selectedOption?.focus();
		selectedOption?.scrollIntoView({ block: "nearest" });
	}

	function messageDialogOption(state, { entryId, wholeSession, text }) {
		const selected = wholeSession ? state.wholeSession : entryId === state.selectedId;
		const option = document.createElement("button");
		option.type = "button";
		option.className = `message-option${selected ? " selected" : ""}`;
		if (wholeSession) option.dataset.wholeSession = "true";
		else option.dataset.entryId = entryId;
		option.setAttribute("role", "radio");
		option.setAttribute("aria-checked", String(selected));
		const radio = document.createElement("span");
		radio.className = "message-radio";
		radio.setAttribute("aria-hidden", "true");
		const label = document.createElement("span");
		label.className = "message-text";
		label.textContent = text;
		option.append(radio, label);
		option.addEventListener("click", () => selectMessageDialogOption(state, option));
		return option;
	}

	function selectMessageDialogOption(state, option) {
		state.selectedId = option.dataset.entryId || undefined;
		state.wholeSession = Boolean(option.dataset.wholeSession);
		for (const candidate of messageDialogList.querySelectorAll(".message-option")) {
			const isSelected = candidate === option;
			candidate.classList.toggle("selected", isSelected);
			candidate.setAttribute("aria-checked", String(isSelected));
		}
		messageDialogSubmit.disabled = false;
	}

	function closeMessageDialog() {
		messageDialog.hidden = true;
		messageDialogList.replaceChildren();
		messageDialogState = undefined;
	}

	function submitMessageDialog() {
		const state = messageDialogState;
		if (!state || (!state.selectedId && !state.wholeSession)) return;
		vscode.postMessage({
			type: "session-history-action",
			action: state.action,
			id: state.sessionId,
			...(!state.wholeSession && { entryId: state.selectedId }),
		});
		closeMessageDialog();
	}

	function closeActiveSessionOrView() {
		const active = activeId && terminals.get(activeId);
		if (active && !active.detached) {
			closeTab(activeId);
			return;
		}
		vscode.postMessage({ type: "close-view" });
	}

	function render() {
		renderTabs();
		renderSessions();
		const open = attachedIds().length;
		emptyState.hidden = open > 0;
		hosts.hidden = open === 0;
	}

	function renderTabs() {
		tabs.replaceChildren();
		for (const [id, entry] of terminals) {
			if (entry.detached) continue;
			const tab = document.createElement("div");
			tab.className = `tab${id === activeId ? " active" : ""}`;
			tab.addEventListener("contextmenu", (event) => {
				event.preventDefault();
				showMenu(tabMenuItems(id), event.clientX, event.clientY);
			});

			const select = document.createElement("button");
			select.type = "button";
			select.className = "tab-select";
			select.textContent = entry.title;
			select.title = entry.title;
			select.setAttribute("aria-pressed", String(id === activeId));
			select.addEventListener("click", () => selectTerminal(id));

			const close = document.createElement("button");
			close.type = "button";
			close.className = "tab-close";
			close.title = closeBehaviorStop ? `Close ${entry.title}` : `Close ${entry.title} (Pi keeps running)`;
			close.setAttribute("aria-label", close.title);
			close.append(icon("close"));
			close.addEventListener("click", (event) => {
				event.stopPropagation();
				closeTab(id);
			});

			tab.append(select, close);
			tabs.append(tab);
		}
	}

	function tabMenuItems(id) {
		return [
			{ label: "Close", hint: closeBehaviorStop ? "Stop the Pi process and close this tab" : "Close this tab; Pi keeps running", run: () => closeTab(id) },
			{ label: STOP_LABEL, hint: "Stop the Pi process and close this tab", run: () => shutdownTerminal(id) },
			...sessionHistoryActionItems(sessionSummaryForTerminal(id)),
			{ label: "Archive", hint: "Close its tab and file this session under Archive", run: () => archiveTerminal(id) },
			{ label: "Delete", hint: DELETE_HINT, run: () => deleteSession(terminals.get(id)?.sessionId) },
		];
	}

	let sessionRenderSignature = "";

	// The extension pushes history on every output burst (500ms debounce); rebuilding the
	// list then recreates the spinner element and its CSS animation restarts, which reads
	// as jank. Rebuild only when the rendered content actually changed.
	function sessionSignature(groups, nowMs) {
		const parts = [search.value.trim(), String(activeId)];
		for (const group of groups) {
			parts.push(group.title, collapsedGroups.has(group.title), expandedGroups.has(group.title));
			for (const session of group.sessions) {
				parts.push(
					session.id,
					normalizedState(session.state),
					session.title,
					Boolean(session.archived),
					String(session.tabId),
					PiSessionView.formatAge(PiSessionView.sessionTimestamp(session), nowMs),
				);
			}
		}
		return parts.join("\u0000");
	}

	function renderSessions(sessions) {
		if (sessions) historySessions = sessions;
		const nowMs = Date.now();
		const groups = PiSessionView.groupSessions(historySessions, { nowMs, query: search.value });
		const signature = sessionSignature(groups, nowMs);
		if (signature === sessionRenderSignature) return;
		sessionRenderSignature = signature;
		sessionList.replaceChildren();
		if (!groups.length) {
			const empty = document.createElement("p");
			empty.className = "list-empty";
			empty.textContent = search.value.trim() ? "No matching sessions." : "No saved sessions.";
			sessionList.append(empty);
			return;
		}
		for (const group of groups) sessionList.append(sessionGroup(group));
	}

	function sessionGroup(group) {
		const section = document.createElement("section");
		section.className = "session-group";

		const collapsed = collapsedGroups.has(group.title);
		const heading = document.createElement("h2");
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.className = `group-toggle${collapsed ? " collapsed" : ""}`;
		toggle.title = `${collapsed ? "Expand" : "Collapse"} ${group.title}`;
		toggle.setAttribute("aria-expanded", String(!collapsed));
		const groupTitle = document.createElement("span");
		groupTitle.className = "group-title";
		groupTitle.textContent = group.title;
		toggle.append(groupTitle, icon(collapsed ? "chevron-right" : "chevron-down", "group-chevron"));
		toggle.addEventListener("click", () => {
			if (collapsed) collapsedGroups.delete(group.title);
			else collapsedGroups.add(group.title);
			renderSessions();
		});
		heading.append(toggle);
		section.append(heading);
		if (collapsed) return section;

		const expanded = expandedGroups.has(group.title);
		const visible = expanded ? group.sessions : group.sessions.slice(0, GROUP_PREVIEW_COUNT);
		for (const session of visible) section.append(sessionRow(session));

		if (group.sessions.length > GROUP_PREVIEW_COUNT) {
			const more = document.createElement("button");
			more.type = "button";
			more.className = "group-more";
			more.append(icon("ellipsis"));
			const label = document.createElement("span");
			label.textContent = expanded ? "Less" : "More";
			more.append(label);
			more.addEventListener("click", () => {
				if (expanded) expandedGroups.delete(group.title);
				else expandedGroups.add(group.title);
				renderSessions();
			});
			section.append(more);
		}
		return section;
	}

	function sessionRow(session) {
		const archived = Boolean(session.archived);
		const state = normalizedState(session.state);
		const selected = activeId !== undefined && session.tabId === activeId;
		const age = PiSessionView.formatAge(PiSessionView.sessionTimestamp(session), Date.now());

		const row = document.createElement("div");
		row.className = `session-row${selected ? " active" : ""}`;

		const open = document.createElement("button");
		open.type = "button";
		open.className = "session-open";
		open.title = `${statusLabels[state]} — ${session.title} (${age})`;
		open.setAttribute("aria-label", `${statusLabels[state]}: ${session.title}, ${age}`);
		open.setAttribute("aria-pressed", String(selected));
		const status = icon(statusIcons[state], `session-status ${state}`);
		const label = document.createElement("span");
		label.className = "session-label";
		label.textContent = session.title;
		open.append(status, label);
		open.addEventListener("click", () => {
			if (session.tabId) selectTerminal(session.tabId);
			vscode.postMessage({ type: "resume", id: session.id });
		});

		const actions = document.createElement("div");
		actions.className = "session-actions";
		const ageLabel = document.createElement("span");
		ageLabel.className = "session-age";
		ageLabel.textContent = age;
		actions.append(ageLabel);

		const archive = document.createElement("button");
		archive.type = "button";
		archive.className = "session-action";
		archive.title = archived ? `Restore ${session.title}` : `Archive ${session.title}`;
		archive.setAttribute("aria-label", archive.title);
		archive.append(icon(archived ? "unarchive" : "archive"));
		archive.addEventListener("click", (event) => {
			event.stopPropagation();
			setArchived(session.id, !archived);
		});
		actions.append(archive);

		row.append(open, actions);
		row.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			const entry = session.tabId ? terminals.get(session.tabId) : undefined;
			const items = [];
			if (entry && !entry.detached) {
				items.push({ label: "Close", hint: closeBehaviorStop ? "Stop the Pi process and close this tab" : "Close this tab; Pi keeps running", run: () => closeTab(session.tabId) });
			}
			// A tab id means the extension still has a live Pi process for this session.
			if (session.tabId) {
				items.push({
					label: STOP_LABEL,
					hint: "Stop the Pi process and close its tab",
					run: () => shutdownTerminal(session.tabId),
				});
			}
			items.push(...sessionHistoryActionItems(session));
			items.push({
				label: archived ? "Restore" : "Archive",
				hint: archived ? "Move this session back to its date group" : "Close its tab and file this session under Archive",
				run: () => setArchived(session.id, !archived),
			});
			items.push({ label: "Delete", hint: DELETE_HINT, run: () => deleteSession(session.id) });
			showMenu(items, event.clientX, event.clientY);
		});
		return row;
	}

	function normalizedState(value) {
		return Object.prototype.hasOwnProperty.call(statusLabels, value) ? value : "inactive";
	}

	function showMenu(items, x, y, owner) {
		menu.replaceChildren();
		if (owner) menu.dataset.owner = owner;
		else delete menu.dataset.owner;
		for (const item of items) {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("role", "menuitem");
			button.textContent = item.label;
			if (item.hint) button.title = item.hint;
			button.disabled = Boolean(item.disabled);
			button.addEventListener("click", () => {
				if (item.disabled) return;
				hideMenu();
				item.run();
			});
			menu.append(button);
		}
		menu.hidden = false;
		const { width, height } = menu.getBoundingClientRect();
		menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
		menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
		menu.querySelector("button:not(:disabled)")?.focus();
	}

	function hideMenu() {
		menu.hidden = true;
		menu.replaceChildren();
		delete menu.dataset.owner;
	}

	// Cmd+F on macOS, Ctrl+Shift+F elsewhere: plain Ctrl+F stays with Pi, matching VS Code's terminal.
	function isFindShortcut(event) {
		if (event.key !== "f" && event.key !== "F") return false;
		return event.metaKey ? !event.ctrlKey : event.ctrlKey && event.shiftKey;
	}

	function searchOptions(incremental) {
		return {
			incremental,
			decorations: {
				matchBackground: color("--vscode-terminal-findMatchHighlightBackground", "#ea5c0055"),
				activeMatchBackground: color("--vscode-terminal-findMatchBackground", "#515c6a"),
				matchOverviewRuler: color("--vscode-terminalOverviewRuler-findMatchForeground", "#d186167e"),
				activeMatchColorOverviewRuler: color("--vscode-terminalOverviewRuler-findMatchForeground", "#d18616"),
			},
		};
	}

	function activeSearch() {
		const entry = activeId && terminals.get(activeId);
		return entry && !entry.detached ? entry.search : undefined;
	}

	function runFind(back, incremental) {
		const search = activeSearch();
		if (!search) return;
		const term = findInput.value;
		if (!term) {
			search.clearDecorations();
			findCount.textContent = "No results";
			return;
		}
		if (back) search.findPrevious(term, searchOptions(false));
		else search.findNext(term, searchOptions(incremental));
	}

	function openFind() {
		const search = activeSearch();
		if (!search) return;
		if (!search.onResults) {
			search.onResults = true;
			search.onDidChangeResults(({ resultIndex, resultCount }) => {
				findCount.textContent = resultCount ? `${resultIndex + 1} of ${resultCount}` : "No results";
			});
		}
		const selection = terminals.get(activeId)?.term.getSelection();
		if (selection && !selection.includes("\n")) findInput.value = selection;
		find.hidden = false;
		findInput.focus();
		findInput.select();
		runFind(false, true);
	}

	function closeFind() {
		if (find.hidden) return;
		find.hidden = true;
		for (const entry of terminals.values()) entry.search?.clearDecorations();
		terminals.get(activeId)?.term.focus();
	}

	function setSidebarVisible(visible) {
		app.classList.toggle("sidebar-hidden", !visible);
		// Clear any dragged width so the inline style can't override the collapse above.
		app.style.gridTemplateColumns = "";
		sidebar.hidden = !visible;
		showSidebar.hidden = visible;
		if (activeId) requestAnimationFrame(() => sendSize(activeId));
	}

	// Auto-hide the sidebar when the panel gets narrow; never auto-show, the user's toggle wins.
	const narrow = matchMedia("(max-width: 640px)");
	narrow.addEventListener("change", () => { if (narrow.matches) setSidebarVisible(false); });
	if (narrow.matches) setSidebarVisible(false);

	// Drag the sidebar's left edge to resize; clamped so it can't go below the usable minimum.
	const SIDEBAR_MIN = 210;
	const grip = document.createElement("div");
	grip.id = "sidebar-grip";
	sidebar.append(grip);
	grip.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		grip.setPointerCapture(e.pointerId);
		const startX = e.clientX;
		const startW = sidebar.getBoundingClientRect().width;
		let raf = 0;
		const move = (ev) => {
			const w = Math.min(Math.max(startW + startX - ev.clientX, SIDEBAR_MIN), innerWidth * 0.7);
			app.style.gridTemplateColumns = `minmax(0, 1fr) ${w}px`;
			if (activeId && !raf) raf = requestAnimationFrame(() => { raf = 0; sendSize(activeId); });
		};
		const up = () => {
			grip.removeEventListener("pointermove", move);
			grip.removeEventListener("pointerup", up);
			if (activeId) sendSize(activeId);
		};
		grip.addEventListener("pointermove", move);
		grip.addEventListener("pointerup", up);
	});

	window.addEventListener("message", (event) => {
		const message = event.data;
		switch (message.type) {
			case "session-open":
				openTerminal(message.id, message.sessionId, message.title);
				break;
			case "data":
				terminals.get(message.id)?.term.write(message.data);
				break;
			case "select":
				selectTerminal(message.id);
				break;
			case "session-close":
				disposeTerminal(message.id);
				break;
			case "session-meta": {
				const entry = terminals.get(message.id);
				if (entry) {
					entry.sessionId = message.sessionId;
					entry.title = message.title;
					render();
				}
				break;
			}
			case "attention":
				playAttentionSound();
				break;
			case "close-active-session-or-view":
				closeActiveSessionOrView();
				break;
			case "history":
				renderSessions(message.sessions);
				break;
			case "user-messages":
				renderMessageDialogMessages(message);
				break;
			case "options":
				options = message.options;
				for (const entry of terminals.values()) applyOptions(entry.term);
				if (activeId) requestAnimationFrame(() => sendSize(activeId));
				break;
			case "close-behavior":
				closeBehaviorStop = message.stop === true;
				render();
				break;
		}
	});

	newTab.append(icon("plus"));
	tabMenu.append(icon("ellipsis"));
	showSidebar.append(icon("sidebar"));
	hideSidebar.append(icon("sidebar"));
	refresh.append(icon("refresh"));
	customize.append(icon("sliders"));
	document.querySelector(".search-icon").append(icon("search"));
	newSession.prepend(icon("plus"));

	const requestNewSession = () => vscode.postMessage({ type: "new" });
	newSession.addEventListener("click", requestNewSession);
	newTab.addEventListener("click", requestNewSession);
	emptyNew.addEventListener("click", requestNewSession);
	customize.addEventListener("click", () => vscode.postMessage({ type: "customize" }));
	refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
	hideSidebar.addEventListener("click", () => setSidebarVisible(false));
	showSidebar.addEventListener("click", () => setSidebarVisible(true));
	search.addEventListener("input", () => renderSessions());
	messageDialogCancel.addEventListener("click", closeMessageDialog);
	messageDialogSubmit.addEventListener("click", submitMessageDialog);
	messageDialog.addEventListener("pointerdown", (event) => {
		if (event.target === messageDialog) closeMessageDialog();
	});
	tabMenu.addEventListener("click", (event) => {
		event.stopPropagation();
		// A second click on the button closes the menu it opened.
		if (!menu.hidden && menu.dataset.owner === "tab-menu") {
			hideMenu();
			return;
		}
		const { left, bottom } = tabMenu.getBoundingClientRect();
		const items = [
			{ label: "New session", run: requestNewSession },
			{ label: "Refresh sessions", run: () => vscode.postMessage({ type: "refresh" }) },
		];
		if (activeId && terminals.has(activeId)) {
			items.push(...sessionHistoryActionItems(sessionSummaryForTerminal(activeId)));
			items.push({ label: "Archive session", run: () => archiveTerminal(activeId) });
			items.push({ label: "Close session", hint: closeBehaviorStop ? "Stop the Pi process and close this tab" : "Pi keeps running", run: () => closeTab(activeId) });
			items.push({ label: `${STOP_LABEL} for this session`, run: () => shutdownTerminal(activeId) });
			items.push({
				label: "Delete session",
				hint: DELETE_HINT,
				run: () => deleteSession(terminals.get(activeId)?.sessionId),
			});
		}
		items.push({
			label: sidebar.hidden ? "Show sessions" : "Hide sessions",
			run: () => setSidebarVisible(sidebar.hidden),
		});
		showMenu(items, left, bottom + 2, "tab-menu");
	});

	document.addEventListener("pointerdown", (event) => {
		unlockSound();
		// The toggle button is excluded so its own click can close the menu instead of
		// closing it here and reopening it.
		if (menu.hidden || menu.contains(event.target) || tabMenu.contains(event.target)) return;
		hideMenu();
	});
	document.addEventListener("keydown", (event) => {
		unlockSound();
		if (event.key !== "Escape") return;
		if (!messageDialog.hidden) {
			closeMessageDialog();
			event.preventDefault();
			return;
		}
		hideMenu();
	});

	// VS Code's webview wrapper swallows native clipboard keydowns (see media/clipboard.js),
	// so keyboard copy/paste runs the same document.execCommand route the context menu uses.
	// The capture phase runs before the wrapper's own window listener, and stopPropagation
	// keeps the wrapper from also forwarding the key to the workbench.
	document.addEventListener(
		"keydown",
		(event) => {
			const target = document.activeElement;
			const xtermTextarea =
				target instanceof HTMLElement && target.classList.contains("xterm-helper-textarea");
			const input =
				target instanceof HTMLInputElement || (target instanceof HTMLTextAreaElement && !xtermTextarea);
			if (!xtermTextarea && !input) return;
			let hasSelection = false;
			if (xtermTextarea) {
				const entry = activeId && terminals.get(activeId);
				hasSelection = Boolean(entry && !entry.detached && entry.term.hasSelection());
			} else {
				hasSelection = target.selectionStart !== target.selectionEnd;
			}
			const action = PiClipboard.clipboardAction(event, hasSelection, { input });
			if (!action) return;
			event.preventDefault();
			event.stopPropagation();
			if (action === "copyAndClear") {
				document.execCommand("copy");
				// Windows terminal behavior: Ctrl+C copies and clears the selection.
				terminals.get(activeId)?.term.clearSelection();
			} else {
				document.execCommand(action);
			}
		},
		true,
	);

	findPrev.append(icon("chevron-up"));
	findNext.append(icon("chevron-down"));
	findClose.append(icon("close"));
	findInput.addEventListener("input", () => runFind(false, true));
	findPrev.addEventListener("click", () => runFind(true, false));
	findNext.addEventListener("click", () => runFind(false, false));
	findClose.addEventListener("click", closeFind);
	findInput.addEventListener("keydown", (event) => {
		if (event.key === "Escape") closeFind();
		else if (event.key === "Enter") runFind(event.shiftKey, false);
		else return;
		event.preventDefault();
	});

	// VS Code rewrites the theme CSS variables on the html element in place, with no event to listen to.
	const themeObserver = new MutationObserver(() => {
		for (const entry of terminals.values()) entry.term.options.theme = xtermTheme();
	});
	for (const node of [document.documentElement, document.body]) {
		themeObserver.observe(node, { attributeFilter: ["class", "style"] });
	}

	new ResizeObserver(() => activeId && requestAnimationFrame(() => sendSize(activeId))).observe(hosts);
	setInterval(() => renderSessions(), 60000);
	render();
	vscode.postMessage({ type: "ready" });
})();
