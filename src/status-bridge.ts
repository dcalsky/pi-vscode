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
	state: ReportedState;
	sourceId: string;
	seq: number;
}

interface WireStatusReport extends PiStatusReport {
	type: "pi-vscode-status";
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

	constructor(private readonly onReport: (report: PiStatusReport) => void) {}

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
		socket.setTimeout(5000, () => socket.destroy());
		socket.on("error", () => undefined);
		socket.once("close", () => this.sockets.delete(socket));

		let pending = "";
		socket.on("data", (chunk: string) => {
			pending += chunk;
			if (Buffer.byteLength(pending) > MAX_MESSAGE_BYTES) {
				socket.destroy();
				return;
			}
			const newline = pending.indexOf("\n");
			if (newline < 0) return;
			this.handleLine(pending.slice(0, newline));
			socket.end();
		});
	}

	private handleLine(line: string): void {
		try {
			const report = JSON.parse(line) as unknown;
			if (!isWireStatusReport(report) || report.token !== this.token) return;
			this.onReport({
				tabId: report.tabId,
				sessionId: report.sessionId,
				sessionPath: report.sessionPath,
				state: report.state,
				sourceId: report.sourceId,
				seq: report.seq,
			});
		} catch {
			// Ignore malformed local messages.
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
		typeof report.sourceId === "string" &&
		Number.isSafeInteger(report.seq) &&
		(report.seq as number) > 0 &&
		typeof report.state === "string" &&
		REPORTED_STATES.has(report.state as ReportedState)
	);
}
