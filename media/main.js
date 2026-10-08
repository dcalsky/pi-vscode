(() => {
	const vscode = acquireVsCodeApi();
	const sessionList = document.getElementById("session-list");
	const search = document.getElementById("search");
	const refresh = document.getElementById("refresh");
	const newSession = document.getElementById("new-session");
	const customize = document.getElementById("customize");
	const menu = document.getElementById("menu");
	const messageDialog = document.getElementById("message-dialog");
	const messageDialogTitle = document.getElementById("message-dialog-title");
	const messageDialogDescription = document.getElementById("message-dialog-description");
	const messageDialogList = document.getElementById("message-dialog-list");
	const messageDialogCancel = document.getElementById("message-dialog-cancel");
	const messageDialogSubmit = document.getElementById("message-dialog-submit");

	const expandedGroups = new Set();
	const collapsedGroups = new Set();
	const GROUP_PREVIEW_COUNT = 6;
	const STOP_LABEL = "Stop Pi";
	const DELETE_HINT = "Stop Pi and delete this session from disk";
	const SESSION_ACTION_DISABLED_HINT = "Available until session is done";
	let historySessions = [];
	let activeTabId;
	let closeBehaviorStop = false;
	let messageDialogState;
	let messageRequestSequence = 0;
	let sessionRenderSignature = "";

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
		archive:
			'<rect x="1.8" y="2.8" width="12.4" height="3.1" rx="1"/><path d="M3.2 6.1v6.1a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V6.1"/><path d="M6.4 9h3.2"/>',
		unarchive:
			'<rect x="1.8" y="2.8" width="12.4" height="3.1" rx="1"/><path d="M3.2 6.1v6.1a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V6.1"/><path d="M8 12.1V8.1m0 0L6.4 9.7M8 8.1l1.6 1.6"/>',
		"check-circle": '<circle cx="8" cy="8" r="5.7"/><path d="M5.6 8.2 7.2 9.8l3.2-3.6"/>',
		spinner: '<circle cx="8" cy="8" r="5.7" stroke-opacity="0.3"/><path d="M8 2.3a5.7 5.7 0 0 1 5.7 5.7"/>',
		sliders: '<path d="M2.6 5.2h10.8M2.6 10.8h10.8"/><circle cx="6" cy="5.2" r="1.6"/><circle cx="10.4" cy="10.8" r="1.6"/>',
		refresh: '<path d="M13.3 8a5.3 5.3 0 1 1-1.6-3.8"/><path d="M13.5 2.7v3.2h-3.2"/>',
		search: '<circle cx="6.9" cy="6.9" r="4.1"/><path d="M10 10 13.6 13.6"/>',
		"chevron-down": '<path d="M4.2 6.4 8 10.1l3.8-3.7"/>',
		"chevron-right": '<path d="M6.4 4.2 10.1 8l-3.7 3.8"/>',
	};

	function icon(name, className) {
		const wrapper = document.createElement("span");
		wrapper.className = className ? `icon ${className}` : "icon";
		wrapper.setAttribute("aria-hidden", "true");
		wrapper.innerHTML = `<svg ${SVG_ATTRIBUTES}>${ICON_PATHS[name] || ""}</svg>`;
		return wrapper;
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
		messageDialogState = {
			action,
			sessionId: session.id,
			requestId,
			selectedId: undefined,
			wholeSession: false,
			messages: [],
		};
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
		if (
			!state ||
			state.requestId !== message.requestId ||
			state.sessionId !== message.sessionId ||
			state.action !== message.action
		) {
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
		if (!state.messages.some((entry) => entry.id === state.selectedId)) state.selectedId = state.messages.at(-1)?.id;
		messageDialogList.replaceChildren();
		if (state.action === "fork") {
			messageDialogList.append(messageDialogOption(state, { wholeSession: true, text: "Whole Session" }));
		}
		for (const entry of state.messages) {
			messageDialogList.append(messageDialogOption(state, { entryId: entry.id, text: entry.text }));
		}
		messageDialogSubmit.disabled = !state.selectedId && !state.wholeSession;
		messageDialogList.querySelector(".message-option.selected")?.focus();
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
		option.addEventListener("click", () => selectMessageDialogOption(option));
		return option;
	}

	function selectMessageDialogOption(option) {
		const state = messageDialogState;
		if (!state) return;
		state.wholeSession = option.dataset.wholeSession === "true";
		state.selectedId = state.wholeSession ? undefined : option.dataset.entryId;
		for (const candidate of messageDialogList.querySelectorAll(".message-option")) {
			const selected = candidate === option;
			candidate.classList.toggle("selected", selected);
			candidate.setAttribute("aria-checked", String(selected));
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

	function sessionSignature(groups, nowMs) {
		const parts = [search.value.trim(), String(activeTabId)];
		for (const group of groups) {
			parts.push(group.title, collapsedGroups.has(group.title), expandedGroups.has(group.title));
			for (const session of group.sessions) {
				parts.push(
					session.id,
					normalizedState(session.state),
					session.title,
					Boolean(session.archived),
					Boolean(session.attached),
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
		const selected = activeTabId !== undefined && session.tabId === activeTabId;
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
		open.addEventListener("click", () => vscode.postMessage({ type: "resume", id: session.id }));

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
			vscode.postMessage({ type: "archive", id: session.id, archived: !archived });
		});
		actions.append(archive);
		row.append(open, actions);

		row.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			const items = [];
			if (session.tabId && session.attached) {
				items.push({
					label: "Close terminal",
					hint: closeBehaviorStop ? "Stop Pi and close the terminal" : "Pi keeps running",
					run: () =>
						vscode.postMessage({ type: closeBehaviorStop ? "shutdown" : "detach", id: session.tabId }),
				});
			}
			if (session.tabId) {
				items.push({
					label: STOP_LABEL,
					hint: "Stop the Pi process and close its terminal",
					run: () => vscode.postMessage({ type: "shutdown", id: session.tabId }),
				});
			}
			items.push({
				label: "Rename",
				hint: "Change the name shown in this list",
				run: () => vscode.postMessage({ type: "rename", id: session.id }),
			});
			items.push(...sessionHistoryActionItems(session));
			items.push({
				label: archived ? "Restore" : "Archive",
				hint: archived ? "Move this session back to its date group" : "Close its terminal and file it under Archive",
				run: () => vscode.postMessage({ type: "archive", id: session.id, archived: !archived }),
			});
			items.push({
				label: "Delete",
				hint: DELETE_HINT,
				run: () => vscode.postMessage({ type: "delete", id: session.id }),
			});
			showMenu(items, event.clientX, event.clientY);
		});
		return row;
	}

	function normalizedState(value) {
		return Object.prototype.hasOwnProperty.call(statusLabels, value) ? value : "inactive";
	}

	function showMenu(items, x, y) {
		menu.replaceChildren();
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
	}

	window.addEventListener("message", (event) => {
		const message = event.data;
		switch (message.type) {
			case "history":
				renderSessions(message.sessions);
				break;
			case "active-session":
				activeTabId = message.tabId;
				renderSessions();
				break;
			case "user-messages":
				renderMessageDialogMessages(message);
				break;
			case "attention":
				playAttentionSound();
				break;
			case "close-behavior":
				closeBehaviorStop = message.stop === true;
				break;
		}
	});

	refresh.append(icon("refresh"));
	customize.append(icon("sliders"));
	document.querySelector(".search-icon").append(icon("search"));
	newSession.prepend(icon("plus"));
	newSession.addEventListener("click", () => vscode.postMessage({ type: "new" }));
	customize.addEventListener("click", () => vscode.postMessage({ type: "customize" }));
	refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
	search.addEventListener("input", () => renderSessions());
	messageDialogCancel.addEventListener("click", closeMessageDialog);
	messageDialogSubmit.addEventListener("click", submitMessageDialog);
	messageDialog.addEventListener("pointerdown", (event) => {
		if (event.target === messageDialog) closeMessageDialog();
	});
	document.addEventListener("pointerdown", (event) => {
		unlockSound();
		if (!menu.hidden && !menu.contains(event.target)) hideMenu();
	});
	document.addEventListener("keydown", (event) => {
		unlockSound();
		if (event.key !== "Escape") return;
		if (!messageDialog.hidden) closeMessageDialog();
		else hideMenu();
		event.preventDefault();
	});

	setInterval(() => renderSessions(), 60_000);
	vscode.postMessage({ type: "ready" });
})();
