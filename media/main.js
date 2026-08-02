(() => {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	const tabs = document.getElementById("tabs");
	const hosts = document.getElementById("terminal-hosts");
	const historyPane = document.getElementById("history-pane");
	const history = document.getElementById("history");
	const refresh = document.getElementById("refresh");
	const newSession = document.getElementById("new-session");
	const newTab = document.getElementById("new-tab");
	const hideHistory = document.getElementById("hide-history");
	const showHistory = document.getElementById("show-history");
	const contextMenu = document.getElementById("context-menu");
	const contextHide = document.getElementById("context-hide");
	const terminals = new Map();
	let activeId;
	let historySessions = [];
	const statusLabels = {
		inactive: "Not open",
		starting: "Starting",
		working: "Working",
		idle: "Idle",
	};

	function color(name, fallback) {
		return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
	}

	let soundContext;

	function unlockSound() {
		const AudioContext = window.AudioContext || window.webkitAudioContext;
		if (!AudioContext) return;
		const context = soundContext ??= new AudioContext();
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
		if (!entry) return;
		entry.fit.fit();
		vscode.postMessage({ type: "resize", id, cols: entry.term.cols, rows: entry.term.rows });
	}

	function openTerminal(id, title) {
		let entry = terminals.get(id);
		if (!entry) {
			const host = document.createElement("div");
			host.className = "terminal-host";
			host.hidden = true;
			hosts.append(host);

			const term = new Terminal({
				cursorBlink: true,
				fontFamily: color("--vscode-editor-font-family", "monospace"),
				fontSize: 13,
				theme: {
					background: color("--vscode-terminal-background", color("--vscode-editor-background", "#1e1e1e")),
					foreground: color("--vscode-terminal-foreground", color("--vscode-foreground", "#cccccc")),
					cursor: color("--vscode-terminalCursor-foreground", "#aeafad"),
					selectionBackground: color("--vscode-terminal-selectionBackground", "#264f78"),
				},
			});
			const fit = new FitAddon.FitAddon();
			term.loadAddon(fit);
			registerTerminalLinks(term);
			term.open(host);
			term.onData((data) => vscode.postMessage({ type: "input", id, data }));
			host.addEventListener("mousedown", () => term.focus());
			entry = { host, term, fit, title, exited: false, detached: false };
			terminals.set(id, entry);
		} else {
			entry.title = title;
			entry.exited = false;
			entry.term.reset();
		}
		selectTerminal(id);
	}

	function selectTerminal(id) {
		const selected = terminals.get(id);
		if (!selected) return;
		selected.detached = false;
		activeId = id;
		for (const [sessionId, entry] of terminals) entry.host.hidden = sessionId !== id;
		renderTabs();
		renderHistory();
		hideContextMenu();
		requestAnimationFrame(() => {
			sendSize(id);
			terminals.get(id)?.term.focus();
		});
	}

	function hideTerminal(id) {
		const entry = terminals.get(id);
		if (!entry) return;
		entry.detached = true;
		entry.host.hidden = true;
		if (activeId === id) activeId = [...terminals].find(([, candidate]) => !candidate.detached)?.[0];
		renderTabs();
		renderHistory();
		hideContextMenu();
		if (activeId) selectTerminal(activeId);
	}

	function closeActiveSessionOrView() {
		const active = activeId && terminals.get(activeId);
		if (active && !active.detached) {
			hideTerminal(activeId);
			return;
		}
		vscode.postMessage({ type: "close-view" });
	}

	function renderTabs() {
		tabs.replaceChildren();
		for (const [id, entry] of terminals) {
			if (entry.detached) continue;
			const tab = document.createElement("div");
			tab.className = `tab${id === activeId ? " active" : ""}${entry.exited ? " exited" : ""}`;
			tab.addEventListener("contextmenu", (event) => {
				event.preventDefault();
				showContextMenu(id, event.clientX, event.clientY);
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
			close.textContent = "×";
			close.title = `Hide ${entry.title}; Pi keeps running`;
			close.setAttribute("aria-label", `Hide ${entry.title}; Pi keeps running`);
			close.addEventListener("click", () => hideTerminal(id));

			tab.append(select, close);
			tabs.append(tab);
		}
	}

	function renderHistory(sessions) {
		if (sessions) historySessions = sessions;
		history.replaceChildren();
		if (!historySessions.length) {
			const empty = document.createElement("p");
			empty.className = "empty";
			empty.textContent = "No saved sessions.";
			history.append(empty);
			return;
		}

		const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
		const recent = historySessions.filter((session) => session.createdAtMs >= cutoff);
		const older = historySessions.filter((session) => session.createdAtMs < cutoff);
		appendHistoryGroup("Last 30 days", recent);
		appendHistoryGroup("Older", older);
	}

	function appendHistoryGroup(title, sessions) {
		if (!sessions.length) return;
		const group = document.createElement("section");
		group.className = "history-group";
		const heading = document.createElement("h2");
		heading.textContent = title;
		group.append(heading);
		for (const session of sessions) {
			const button = document.createElement("button");
			const selected = activeId !== undefined && session.tabId === activeId;
			const state = normalizedState(session.state);
			button.type = "button";
			button.className = `history-session${selected ? " active" : ""}`;
			button.title = `${statusLabels[state]} — ${session.title}`;
			button.setAttribute("aria-label", `${statusLabels[state]}: ${session.title}`);
			button.setAttribute("aria-pressed", String(selected));

			const icon = document.createElement("span");
			icon.className = `session-status ${state}`;
			icon.setAttribute("aria-hidden", "true");
			const label = document.createElement("span");
			label.className = "session-label";
			label.textContent = session.title;
			button.append(icon, label);

			button.addEventListener("click", () => {
				if (session.tabId) selectTerminal(session.tabId);
				vscode.postMessage({ type: "resume", id: session.id });
			});
			group.append(button);
		}
		history.append(group);
	}

	function normalizedState(value) {
		return Object.prototype.hasOwnProperty.call(statusLabels, value) ? value : "inactive";
	}

	function showContextMenu(id, x, y) {
		contextMenu.dataset.sessionId = id;
		contextMenu.hidden = false;
		const { width, height } = contextMenu.getBoundingClientRect();
		contextMenu.style.left = `${Math.min(x, window.innerWidth - width - 4)}px`;
		contextMenu.style.top = `${Math.min(y, window.innerHeight - height - 4)}px`;
		contextHide.focus();
	}

	function hideContextMenu() {
		contextMenu.hidden = true;
		delete contextMenu.dataset.sessionId;
	}

	function setHistoryVisible(visible) {
		app.classList.toggle("history-hidden", !visible);
		historyPane.hidden = !visible;
		showHistory.hidden = visible;
		if (activeId) requestAnimationFrame(() => sendSize(activeId));
	}

	window.addEventListener("message", (event) => {
		const message = event.data;
		switch (message.type) {
			case "session-open":
				openTerminal(message.id, message.title);
				break;
			case "data":
				terminals.get(message.id)?.term.write(message.data);
				break;
			case "select":
				selectTerminal(message.id);
				break;
			case "session-exit": {
				const entry = terminals.get(message.id);
				if (entry) {
					entry.exited = true;
					entry.term.write(`\r\n[pi exited with code ${message.exitCode}]\r\n`);
					renderTabs();
					renderHistory();
				}
				break;
			}
			case "session-title": {
				const entry = terminals.get(message.id);
				if (entry) {
					entry.title = message.title;
					renderTabs();
					renderHistory();
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
				renderHistory(message.sessions);
				break;
		}
	});

	newSession.addEventListener("click", () => vscode.postMessage({ type: "new" }));
	newTab.addEventListener("click", () => vscode.postMessage({ type: "new" }));
	refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
	hideHistory.addEventListener("click", () => setHistoryVisible(false));
	showHistory.addEventListener("click", () => setHistoryVisible(true));
	contextHide.addEventListener("click", () => {
		const id = contextMenu.dataset.sessionId;
		if (id) hideTerminal(id);
	});
	document.addEventListener("pointerdown", (event) => {
		unlockSound();
		if (!contextMenu.hidden && !contextMenu.contains(event.target)) hideContextMenu();
	});
	document.addEventListener("keydown", (event) => {
		unlockSound();
		if (event.key === "Escape") hideContextMenu();
	});
	new ResizeObserver(() => activeId && requestAnimationFrame(() => sendSize(activeId))).observe(hosts);
	vscode.postMessage({ type: "ready" });
})();
