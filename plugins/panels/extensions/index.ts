/**
 * pi-vscode-panels — panel orchestration tools for Pi sessions running inside
 * the Pi VS Code extension (https://github.com/dcalsky/pi-vscode).
 *
 * Registers panel_create / panel_prompt / panel_wait / panel_list so one Pi
 * session can spawn and drive sibling sessions (panels) in background tabs —
 * the way the herdr CLI lets an agent drive neighboring panes.
 *
 * The tools register only when the session was started by the VS Code
 * extension (PI_VSCODE_STATUS_* env present); elsewhere this package is inert.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import net from "node:net";
import { Type } from "typebox";

const socketPath = process.env.PI_VSCODE_STATUS_SOCKET;
const token = process.env.PI_VSCODE_STATUS_TOKEN;
const ownTabId = process.env.PI_VSCODE_STATUS_TAB_ID;

const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60_000;

interface PanelCreateResult {
	tabId: string;
	sessionId: string;
}

interface PanelPromptResult {
	tabId: string;
	promptedAtMs: number;
}

interface PanelWaitResult {
	tabId: string;
	state: string;
	settled: boolean;
}

interface PanelWaitAllResult {
	settled: boolean;
	panels: Array<{ tabId: string; state: string; settled: boolean }>;
}

type PanelWaitDetails = PanelWaitResult | PanelWaitAllResult;

type PanelListResult = Array<{
	tabId: string;
	sessionId: string;
	title: string;
	state: string;
}>;

function enabled(): boolean {
	return Boolean(socketPath && token && ownTabId);
}

/** One JSON-line request/response per connection over the extension's status socket. */
function panelRequest<T>(
	action: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	timeoutMs = 60_000,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let pending = "";
		const socket = net.createConnection(socketPath!);
		const finish = (error?: Error, result?: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			if (error) reject(error);
			else resolve(result as T);
		};
		const onAbort = () => finish(new Error("Cancelled"));
		const timer = setTimeout(
			() => finish(new Error(`Pi VS Code bridge did not answer within ${Math.round(timeoutMs / 1000)}s`)),
			timeoutMs,
		);
		timer.unref?.();
		socket.setEncoding("utf8");
		socket.on("error", () => finish(new Error("Could not reach the Pi VS Code bridge")));
		socket.on("close", () => finish(new Error("The Pi VS Code bridge closed the connection without a response")));
		socket.on("connect", () => {
			signal?.addEventListener("abort", onAbort);
			const requestId = `panel:${Date.now()}:${Math.random().toString(36).slice(2)}`;
			socket.write(`${JSON.stringify({ type: "pi-vscode-panel", token, requestId, action, ...params })}\n`);
		});
		socket.on("data", (chunk: string) => {
			pending += chunk;
			const newline = pending.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(pending.slice(0, newline)) as { ok?: boolean; result?: T; error?: unknown };
				if (response?.ok === true) finish(undefined, response.result);
				else finish(new Error(typeof response?.error === "string" ? response.error : "Panel request failed"));
			} catch {
				finish(new Error("Malformed response from the Pi VS Code bridge"));
			}
		});
	});
}

export default function (pi: ExtensionAPI): void {
	if (!enabled()) return;

	// panel_wait defaults its "prompted after" timestamp to the last panel_prompt for that tab.
	const promptedAtMs = new Map<string, number>();

	pi.registerTool({
		name: "panel_create",
		label: "Panel Create",
		description:
			"Open a new sibling Pi session in its own tab of the Pi VS Code view, without stealing the user's focus. " +
			"Resolves once the panel's Pi is ready for input and returns the tabId used by panel_prompt, panel_wait, and panel_list.",
		promptSnippet: "Spawn and drive sibling Pi sessions (panels) in this VS Code window",
		promptGuidelines: [
			"Use panel_create to spawn a sibling Pi session when the user asks for multi-agent, panel, or parallel review workflows; it opens in the background and returns once ready.",
			"Use panel_prompt to assign a panel its task; exchange briefs and results through files in the workspace (for example a review/ directory) and tell the panel in the prompt which files to read and where to write its result.",
			"Use panel_wait after panel_prompt to block until that panel goes idle; pass tabIds to wait for several panels at once, so panels work in parallel.",
		],
		parameters: Type.Object({
			model: Type.Optional(
				Type.String({
					description:
						'Model pattern for the panel\'s Pi, e.g. "anthropic/claude-sonnet-4-5" or "openai/gpt-5:high". Omit for the default model.',
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await panelRequest<PanelCreateResult>(
				"create",
				params.model === undefined ? {} : { model: params.model },
				signal,
				60_000,
			);
			const withModel = params.model === undefined ? "" : ` (model: ${params.model})`;
			return {
				content: [{ type: "text", text: `Panel ${result.tabId}${withModel} is ready. Assign work with panel_prompt.` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "panel_prompt",
		label: "Panel Prompt",
		description:
			"Submit a prompt to a sibling panel's Pi, like typing it and pressing Enter. The panel must be idle at its prompt. " +
			"Keep the prompt short: point the panel at workspace files to read and name the file it must write its result to. " +
			"Returns immediately; use panel_wait to wait for the turn to finish.",
		parameters: Type.Object({
			tabId: Type.String({ description: "Panel tabId from panel_create or panel_list" }),
			text: Type.String({ description: "Prompt text; newlines are pasted literally, not submitted" }),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await panelRequest<PanelPromptResult>(
				"prompt",
				{ tabId: params.tabId, text: params.text },
				signal,
			);
			promptedAtMs.set(params.tabId, result.promptedAtMs);
			return {
				content: [
					{ type: "text", text: `Prompt submitted to panel ${params.tabId}. Use panel_wait to wait for completion.` },
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "panel_wait",
		label: "Panel Wait",
		description:
			"Wait until panels finish the turns started by panel_prompt and go idle (or exit). " +
			"Pass tabId for one panel, or tabIds to wait until every listed panel settles (fan-in for parallel work). " +
			"On timeout the panels keep working; call panel_wait again to keep waiting.",
		parameters: Type.Object({
			tabId: Type.Optional(Type.String({ description: "Panel tabId from panel_create or panel_list" })),
			tabIds: Type.Optional(
				Type.Array(Type.String(), { description: "Wait for all of these panels instead of a single tabId" }),
			),
			timeoutMs: Type.Optional(
				Type.Number({ description: `Maximum wait in milliseconds (default ${DEFAULT_WAIT_TIMEOUT_MS})` }),
			),
		}),
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<PanelWaitDetails>> {
			const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS;
			if (params.tabIds !== undefined) {
				if (params.tabIds.length === 0) throw new Error("tabIds must not be empty");
				const sinces = params.tabIds
					.map((tabId) => promptedAtMs.get(tabId))
					.filter((since): since is number => since !== undefined);
				const result = await panelRequest<PanelWaitAllResult>(
					"wait",
					{
						tabIds: params.tabIds,
						...(sinces.length === 0 ? {} : { sinceMs: Math.min(...sinces) }),
						timeoutMs,
					},
					signal,
					timeoutMs + 60_000,
				);
				const lines = result.panels.map(
					(panel) => `${panel.tabId}: ${panel.state}${panel.settled ? "" : " (still running)"}`,
				);
				const summary = result.settled
					? `All ${result.panels.length} panels settled. Read their result files.`
					: `Some panels are still working after ${Math.round(timeoutMs / 1000)}s. Call panel_wait again to keep waiting.`;
				return { content: [{ type: "text", text: `${summary}\n${lines.join("\n")}` }], details: result };
			}
			if (params.tabId === undefined) throw new Error("panel_wait requires tabId or tabIds");
			const sinceMs = promptedAtMs.get(params.tabId);
			const result = await panelRequest<PanelWaitResult>(
				"wait",
				{ tabId: params.tabId, ...(sinceMs === undefined ? {} : { sinceMs }), timeoutMs },
				signal,
				timeoutMs + 60_000,
			);
			let text: string;
			if (result.settled && result.state === "idle") {
				text = `Panel ${params.tabId} finished (idle). Read the result file it was asked to write.`;
			} else if (result.settled) {
				text = `Panel ${params.tabId} exited (state: ${result.state}). Its session can be resumed from the session list.`;
			} else {
				text = `Panel ${params.tabId} is still ${result.state} after ${Math.round(timeoutMs / 1000)}s. Call panel_wait again to keep waiting.`;
			}
			return { content: [{ type: "text", text }], details: result };
		},
	});

	pi.registerTool({
		name: "panel_list",
		label: "Panel List",
		description:
			"List every Pi session in this VS Code window with its tabId, title, and state " +
			"(starting, working, idle, inactive). The calling session is marked as self.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			const sessions = await panelRequest<PanelListResult>("list", {}, signal);
			const marked = sessions.map((session) => ({ ...session, self: session.tabId === ownTabId }));
			return {
				content: [{ type: "text", text: JSON.stringify(marked, null, 2) }],
				details: { sessions: marked },
			};
		},
	});
}
