import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";
import { becameIdle, PiStatusBridge, type PiStatusReport } from "../status-bridge";

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

function send(socketPath: string, message: object): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("error", reject);
		socket.once("connect", () => socket.end(`${JSON.stringify(message)}\n`));
		socket.once("close", () => resolve());
	});
}
