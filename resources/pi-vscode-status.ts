// Loaded only by Pi processes started from the VS Code extension.
// @ts-nocheck

import net from "node:net";

const socketPath = process.env.PI_VSCODE_STATUS_SOCKET;
const token = process.env.PI_VSCODE_STATUS_TOKEN;
const tabId = process.env.PI_VSCODE_STATUS_TAB_ID;
const sourceId = `pi-vscode:${Date.now()}:${Math.random().toString(36).slice(2)}`;

let sequence = 0;
let rootSession = false;
let currentSessionId: string | undefined;
let currentSessionPath: string | undefined;
let lastState: "working" | "idle" | undefined;

function enabled(): boolean {
	return Boolean(socketPath && token && tabId);
}

function updateSessionRef(ctx: any): void {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		currentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		currentSessionId = undefined;
	}

	try {
		const path = ctx?.sessionManager?.getSessionFile?.();
		currentSessionPath = typeof path === "string" ? path : undefined;
	} catch {
		currentSessionPath = undefined;
	}
}

function publish(state: "working" | "idle", force = false): void {
	if (!enabled() || !currentSessionId || (!force && state === lastState)) return;
	lastState = state;

	const payload = {
		type: "pi-vscode-status",
		token,
		tabId,
		sessionId: currentSessionId,
		sessionPath: currentSessionPath,
		state,
		sourceId,
		seq: ++sequence,
	};
	let socket: net.Socket | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const finish = () => {
		if (timeout) clearTimeout(timeout);
		socket?.destroy();
	};

	try {
		socket = net.createConnection(socketPath!);
		socket.once("error", finish);
		socket.once("connect", () => socket?.end(`${JSON.stringify(payload)}\n`));
		socket.once("close", finish);
		timeout = setTimeout(finish, 500);
		timeout.unref?.();
	} catch {
		finish();
	}
}

export default function (pi: any): void {
	pi.on("session_start", (_event: any, ctx: any) => {
		if (ctx?.hasUI !== true || !enabled()) return;
		rootSession = true;
		updateSessionRef(ctx);
		publish(ctx?.isIdle?.() === false ? "working" : "idle", true);
	});

	pi.on("agent_start", (_event: any, ctx: any) => {
		if (!rootSession) return;
		updateSessionRef(ctx);
		publish("working");
	});

	pi.on("agent_settled", (_event: any, ctx: any) => {
		if (!rootSession || ctx?.isIdle?.() !== true) return;
		updateSessionRef(ctx);
		publish("idle");
	});
}
