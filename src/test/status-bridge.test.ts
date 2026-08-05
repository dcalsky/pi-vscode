import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";
import { becameIdle, PiStatusBridge, type PiForkRequest, type PiStatusReport } from "../status-bridge";

test("relays only token-authenticated Pi status reports", async () => {
	const reports: PiStatusReport[] = [];
	let resolveReport: (() => void) | undefined;
	const received = new Promise<void>((resolve) => {
		resolveReport = resolve;
	});
	const bridge = new PiStatusBridge((report) => {
		reports.push(report);
		resolveReport?.();
	});
	await bridge.start();

	const environment = bridge.environmentFor("tab-1");
	await send(environment.PI_VSCODE_STATUS_SOCKET!, {
		type: "pi-vscode-status",
		token: environment.PI_VSCODE_STATUS_TOKEN,
		tabId: "tab-1",
		sessionId: "session-1",
		state: "working",
		sourceId: "test",
		seq: 1,
	});
	await received;
	assert.deepEqual(reports, [
		{
			tabId: "tab-1",
			sessionId: "session-1",
			state: "working",
			sourceId: "test",
			seq: 1,
			sessionPath: undefined,
		},
	]);

	await send(environment.PI_VSCODE_STATUS_SOCKET!, {
		type: "pi-vscode-status",
		token: "wrong",
		tabId: "tab-1",
		sessionId: "session-1",
		state: "idle",
		sourceId: "test",
		seq: 2,
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(reports.length, 1);
	await bridge.dispose();
});

test("detects only working-to-idle transitions", () => {
	assert.equal(becameIdle("working", "idle"), true);
	assert.equal(becameIdle("starting", "idle"), false);
	assert.equal(becameIdle("idle", "idle"), false);
	assert.equal(becameIdle("working", "working"), false);
});

test("relays and acknowledges token-authenticated fork requests", async () => {
	const requests: PiForkRequest[] = [];
	const bridge = new PiStatusBridge(
		() => undefined,
		(request) => {
			requests.push(request);
		},
	);
	await bridge.start();
	const environment = bridge.environmentFor("tab-1");
	const payload = {
		type: "pi-vscode-fork",
		token: environment.PI_VSCODE_STATUS_TOKEN,
		requestId: "request-1",
		tabId: "tab-1",
		sourceSessionId: "source-1",
		sessionId: "fork-1",
		sessionPath: "/tmp/fork-1.jsonl",
		draftFile: "/tmp/pi-vscode-fork-test/draft",
	};

	const response = await request(environment.PI_VSCODE_STATUS_SOCKET!, payload);
	assert.deepEqual(response, { type: "pi-vscode-fork-result", requestId: "request-1", ok: true });
	assert.deepEqual(requests, [
		{
			requestId: "request-1",
			tabId: "tab-1",
			sourceSessionId: "source-1",
			sessionId: "fork-1",
			sessionPath: "/tmp/fork-1.jsonl",
			draftFile: "/tmp/pi-vscode-fork-test/draft",
		},
	]);
	await bridge.dispose();
});

test("returns a fork handler failure to Pi", async () => {
	const bridge = new PiStatusBridge(
		() => undefined,
		() => {
			throw new Error("cannot open target");
		},
	);
	await bridge.start();
	const environment = bridge.environmentFor("tab-1");
	const response = await request(environment.PI_VSCODE_STATUS_SOCKET!, {
		type: "pi-vscode-fork",
		token: environment.PI_VSCODE_STATUS_TOKEN,
		requestId: "request-2",
		tabId: "tab-1",
		sourceSessionId: "source-1",
		sessionId: "fork-1",
		sessionPath: "/tmp/fork-1.jsonl",
		draftFile: "/tmp/pi-vscode-fork-test/draft",
	});

	assert.deepEqual(response, {
		type: "pi-vscode-fork-result",
		requestId: "request-2",
		ok: false,
		error: "cannot open target",
	});
	await bridge.dispose();
});

function send(socketPath: string, message: object): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("error", reject);
		socket.once("connect", () => socket.end(`${JSON.stringify(message)}\n`));
		socket.once("close", () => resolve());
	});
}

function request(socketPath: string, message: object): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let response = "";
		socket.setEncoding("utf8");
		socket.once("error", reject);
		socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
		socket.on("data", (chunk: string) => {
			response += chunk;
			const newline = response.indexOf("\n");
			if (newline < 0) return;
			socket.destroy();
			resolve(JSON.parse(response.slice(0, newline)) as unknown);
		});
		socket.once("close", () => {
			if (!response.includes("\n")) reject(new Error("socket closed before a response"));
		});
	});
}
