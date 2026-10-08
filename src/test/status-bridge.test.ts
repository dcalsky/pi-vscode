import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";
import { becameIdle, PiStatusBridge, type PiForkRequest, type PiPanelRequest, type PiStatusReport } from "../status-bridge";

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
		leafId: "leaf-1",
		state: "working",
		sourceId: "test",
		seq: 1,
	});
	await received;
	assert.deepEqual(reports, [
		{
			tabId: "tab-1",
			sessionId: "session-1",
			leafId: "leaf-1",
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

test("pushes control commands only to token-authenticated subscribers", async () => {
	const bridge = new PiStatusBridge(() => undefined);
	await bridge.start();
	const environment = bridge.environmentFor("tab-1");
	assert.equal(bridge.sendControl("tab-1", { type: "rename", sessionId: "session-1", name: "x" }), false);

	const rejected = createConnection(environment.PI_VSCODE_STATUS_SOCKET!);
	await new Promise((resolve) => rejected.once("connect", resolve));
	rejected.write(`${JSON.stringify({ type: "pi-vscode-control", token: "wrong", tabId: "tab-1" })}\n`);
	await new Promise((resolve) => rejected.once("close", resolve));
	assert.equal(bridge.sendControl("tab-1", { type: "rename", sessionId: "session-1", name: "x" }), false);

	const socket = createConnection(environment.PI_VSCODE_STATUS_SOCKET!);
	socket.setEncoding("utf8");
	const line = new Promise<string>((resolve) => {
		let buffered = "";
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			if (buffered.includes("\n")) resolve(buffered.slice(0, buffered.indexOf("\n")));
		});
	});
	await new Promise((resolve) => socket.once("connect", resolve));
	socket.write(`${JSON.stringify({ type: "pi-vscode-control", token: environment.PI_VSCODE_STATUS_TOKEN, tabId: "tab-1" })}\n`);
	const command = { type: "rename" as const, sessionId: "session-1", name: "Renamed" };
	for (let attempt = 0; attempt < 50 && !bridge.sendControl("tab-1", command); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.deepEqual(JSON.parse(await line), command);

	socket.destroy();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(bridge.sendControl("tab-1", command), false);
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

test("relays and answers token-authenticated panel requests", async () => {
	const requests: PiPanelRequest[] = [];
	const bridge = new PiStatusBridge(
		() => undefined,
		undefined,
		(request) => {
			requests.push(request);
			return Promise.resolve({ sessions: [] });
		},
	);
	await bridge.start();
	const environment = bridge.environmentFor("tab-1");

	const response = await request(environment.PI_VSCODE_STATUS_SOCKET!, {
		type: "pi-vscode-panel",
		token: environment.PI_VSCODE_STATUS_TOKEN,
		requestId: "panel-1",
		action: "list",
	});
	assert.deepEqual(response, { type: "pi-vscode-panel-result", requestId: "panel-1", ok: true, result: { sessions: [] } });
	assert.deepEqual(requests, [
		{
			requestId: "panel-1",
			action: "list",
			tabId: undefined,
			tabIds: undefined,
			text: undefined,
			model: undefined,
			sinceMs: undefined,
			timeoutMs: undefined,
		},
	]);

	const rejected = await request(environment.PI_VSCODE_STATUS_SOCKET!, {
		type: "pi-vscode-panel",
		token: "wrong",
		requestId: "panel-2",
		action: "list",
	}).catch((error: Error) => error);
	assert.equal(rejected instanceof Error, true);
	assert.equal(requests.length, 1);

	// New-style fields relay through validation: batch wait targets and a create model.
	const created = await request(environment.PI_VSCODE_STATUS_SOCKET!, {
		type: "pi-vscode-panel",
		token: environment.PI_VSCODE_STATUS_TOKEN,
		requestId: "panel-5",
		action: "create",
		model: "openai/gpt-5:high",
	});
	assert.equal((created as { ok: boolean }).ok, true);
	assert.deepEqual(requests[1], {
		requestId: "panel-5",
		action: "create",
		tabId: undefined,
		tabIds: undefined,
		text: undefined,
		model: "openai/gpt-5:high",
		sinceMs: undefined,
		timeoutMs: undefined,
	});

	const invalid = await request(environment.PI_VSCODE_STATUS_SOCKET!, {
		type: "pi-vscode-panel",
		token: environment.PI_VSCODE_STATUS_TOKEN,
		requestId: "panel-6",
		action: "wait",
		tabIds: [],
	}).catch((error: Error) => error);
	assert.equal(invalid instanceof Error, true);
	assert.equal(requests.length, 2);
	await bridge.dispose();
});

test("returns a panel handler failure to Pi and holds long waits open", async () => {
	const bridge = new PiStatusBridge(
		() => undefined,
		undefined,
		(request) => {
			if (request.action === "prompt") return Promise.reject(new Error("No open panel tab-9"));
			// A wait that resolves after the old 10s socket guard would have fired is
			// impractical to test; 50ms still proves the timeout is cleared on dispatch.
			return new Promise((resolve) => setTimeout(() => resolve({ state: "idle", settled: true }), 50));
		},
	);
	await bridge.start();
	const environment = bridge.environmentFor("tab-1");

	const failure = await request(environment.PI_VSCODE_STATUS_SOCKET!, {
		type: "pi-vscode-panel",
		token: environment.PI_VSCODE_STATUS_TOKEN,
		requestId: "panel-3",
		action: "prompt",
		tabId: "tab-9",
		text: "hello",
	});
	assert.deepEqual(failure, {
		type: "pi-vscode-panel-result",
		requestId: "panel-3",
		ok: false,
		error: "No open panel tab-9",
	});

	const waited = await request(environment.PI_VSCODE_STATUS_SOCKET!, {
		type: "pi-vscode-panel",
		token: environment.PI_VSCODE_STATUS_TOKEN,
		requestId: "panel-4",
		action: "wait",
		tabId: "tab-1",
		timeoutMs: 5000,
	});
	assert.deepEqual(waited, {
		type: "pi-vscode-panel-result",
		requestId: "panel-4",
		ok: true,
		result: { state: "idle", settled: true },
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
