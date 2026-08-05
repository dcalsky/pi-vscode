import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

export type PiSessionState = "inactive" | "starting" | "working" | "idle";

type ReportedState = Extract<PiSessionState, "working" | "idle">;

export interface PiStatusReport {
	tabId: string;
	sessionId: string;
	sessionPath?: string;
	leafId?: string;
	state: ReportedState;
	sourceId: string;
	seq: number;
}

export interface PiForkRequest {
	requestId: string;
	tabId: string;
	sourceSessionId: string;
	sessionId: string;
	sessionPath: string;
	draftFile: string;
}

interface WireStatusReport extends PiStatusReport {
	type: "pi-vscode-status";
	token: string;
}

interface WireForkRequest extends PiForkRequest {
	type: "pi-vscode-fork";
	token: string;
}

const MAX_MESSAGE_BYTES = 16 * 1024;
const REPORTED_STATES = new Set<ReportedState>(["working", "idle"]);

export function becameIdle(previous: PiSessionState | undefined, next: ReportedState): boolean {
	return previous === "working" && next === "idle";
}

export class PiStatusBridge {
	private readonly endpoint = socketEndpoint();
	private readonly token = randomUUID();
	private readonly sockets = new Set<Socket>();
	private server: Server | undefined;
	private listening = false;
	private disposed = false;

	constructor(
		private readonly onReport: (report: PiStatusReport) => void,
		private readonly onForkRequest?: (request: PiForkRequest) => void | Promise<void>,
	) {}

	get isListening(): boolean {
		return this.listening;
	}

	environmentFor(tabId: string): Record<string, string> {
		if (!this.listening) return {};
		return {
			PI_VSCODE_STATUS_SOCKET: this.endpoint,
			PI_VSCODE_STATUS_TOKEN: this.token,
			PI_VSCODE_STATUS_TAB_ID: tabId,
		};
	}

	async start(): Promise<void> {
		if (this.listening) return;
		if (this.disposed) throw new Error("Pi status bridge is disposed");
		this.removeSocketFile();

		const server = createServer((socket) => this.handleConnection(socket));
		server.on("error", () => undefined);
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				this.server = undefined;
				this.removeSocketFile();
				reject(error);
			};
			server.once("error", onError);
			server.listen(this.endpoint, () => {
				server.off("error", onError);
				if (this.disposed) {
					this.server = undefined;
					server.close(() => {
						this.removeSocketFile();
						resolve();
					});
					return;
				}
				this.listening = true;
				resolve();
			});
		});
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.listening = false;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();

		const server = this.server;
		this.server = undefined;
		if (server?.listening) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		this.removeSocketFile();
	}

	private handleConnection(socket: Socket): void {
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		socket.setTimeout(10_000, () => socket.destroy());
		socket.on("error", () => undefined);
		socket.once("close", () => this.sockets.delete(socket));

		let pending = "";
		let handled = false;
		socket.on("data", (chunk: string) => {
			if (handled) return;
			pending += chunk;
			if (Buffer.byteLength(pending) > MAX_MESSAGE_BYTES) {
				socket.destroy();
				return;
			}
			const newline = pending.indexOf("\n");
			if (newline < 0) return;
			handled = true;
			void this.handleLine(pending.slice(0, newline), socket);
		});
	}

	private async handleLine(line: string, socket: Socket): Promise<void> {
		try {
			const message = JSON.parse(line) as unknown;
			if (isWireStatusReport(message) && message.token === this.token) {
				this.onReport({
					tabId: message.tabId,
					sessionId: message.sessionId,
					sessionPath: message.sessionPath,
					leafId: message.leafId,
					state: message.state,
					sourceId: message.sourceId,
					seq: message.seq,
				});
				socket.end();
				return;
			}

			if (!isWireForkRequest(message) || message.token !== this.token) {
				socket.end();
				return;
			}

			try {
				if (!this.onForkRequest) throw new Error("Fork requests are unavailable");
				await this.onForkRequest({
					requestId: message.requestId,
					tabId: message.tabId,
					sourceSessionId: message.sourceSessionId,
					sessionId: message.sessionId,
					sessionPath: message.sessionPath,
					draftFile: message.draftFile,
				});
				socket.end(
					`${JSON.stringify({ type: "pi-vscode-fork-result", requestId: message.requestId, ok: true })}\n`,
				);
			} catch (error) {
				socket.end(
					`${JSON.stringify({
						type: "pi-vscode-fork-result",
						requestId: message.requestId,
						ok: false,
						error: errorMessage(error),
					})}\n`,
				);
			}
		} catch {
			// Ignore malformed local messages.
			socket.end();
		}
	}

	private removeSocketFile(): void {
		if (process.platform === "win32") return;
		try {
			rmSync(this.endpoint, { force: true });
		} catch {
			// The socket may not have been created yet.
		}
	}
}

function socketEndpoint(): string {
	const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\pi-vscode-${suffix}` : join("/tmp", `pi-vscode-${suffix}.sock`);
}

function isWireStatusReport(value: unknown): value is WireStatusReport {
	if (!value || typeof value !== "object") return false;
	const report = value as Record<string, unknown>;
	return (
		report.type === "pi-vscode-status" &&
		typeof report.token === "string" &&
		typeof report.tabId === "string" &&
		typeof report.sessionId === "string" &&
		(report.sessionPath === undefined || typeof report.sessionPath === "string") &&
		(report.leafId === undefined || typeof report.leafId === "string") &&
		typeof report.sourceId === "string" &&
		Number.isSafeInteger(report.seq) &&
		(report.seq as number) > 0 &&
		typeof report.state === "string" &&
		REPORTED_STATES.has(report.state as ReportedState)
	);
}

function isWireForkRequest(value: unknown): value is WireForkRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Record<string, unknown>;
	return (
		request.type === "pi-vscode-fork" &&
		nonEmptyString(request.token) &&
		nonEmptyString(request.requestId) &&
		nonEmptyString(request.tabId) &&
		nonEmptyString(request.sourceSessionId) &&
		nonEmptyString(request.sessionId) &&
		nonEmptyString(request.sessionPath) &&
		nonEmptyString(request.draftFile)
	);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
