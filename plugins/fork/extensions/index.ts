// Loaded only by Pi processes started from the VS Code extension.

import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
  UserMessageSelectorComponent,
} from "@earendil-works/pi-coding-agent";

type ForkMessage = {
  entryId: string;
  text: string;
};

type ForkedSession = {
  id: string;
  path: string;
  title: string;
};

type ForkRequestPayload = {
  requestId: string;
  tabId: string;
  sourceSessionId: string;
  sessionId: string;
  sessionPath: string;
  draftFile: string;
};

const NEW_SESSION_TITLE = "New Session";
const DRAFT_FILE_ENV = "PI_VSCODE_FORK_DRAFT_FILE";
const DRAFT_DIR_PREFIX = "pi-vscode-fork-";
const DRAFT_FILE_NAME = "draft";
const DRAFT_ACK_FILE_NAME = "consumed";
const DRAFT_CONSUME_ATTEMPTS = 100;
const DRAFT_CONSUME_RETRY_MS = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

class ForkRequestError extends Error {
  constructor(
    message: string,
    readonly targetMayExist: boolean,
  ) {
    super(message);
    this.name = "ForkRequestError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const text: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") text.push(candidate.text);
  }
  return text.join("");
}

function forkMessages(ctx: ExtensionCommandContext): ForkMessage[] {
  return ctx.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const text = extractMessageText(entry.message.content);
    return text.trim() ? [{ entryId: entry.id, text }] : [];
  });
}

async function chooseForkMessage(
  ctx: ExtensionCommandContext,
  messages: ForkMessage[],
): Promise<ForkMessage | undefined> {
  const initialSelectedId = messages.at(-1)?.entryId;
  const selectedEntryId = await ctx.ui.custom<string | undefined>(
    (tui, _theme, _keybindings, done) => {
      const selector = new UserMessageSelectorComponent(
        messages.map(({ entryId, text }) => ({ id: entryId, text })),
        done,
        () => done(undefined),
        initialSelectedId,
      );
      const list = selector.getMessageList();
      return {
        render: (width: number) => selector.render(width),
        invalidate: () => selector.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
  return messages.find((message) => message.entryId === selectedEntryId);
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function nextForkTitle(
  ctx: ExtensionCommandContext,
  sourceSessionFile: string,
): Promise<string> {
  const sourceTitle = ctx.sessionManager.getSessionName()?.trim() || NEW_SESSION_TITLE;
  const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
  const children = sessions.filter(
    (session) =>
      session.parentSessionPath && samePath(session.parentSessionPath, sourceSessionFile),
  );
  let highestNamedIndex = 0;
  for (const child of children) {
    const match = child.name?.match(/^\((\d+)\)\s(.*)$/);
    if (!match || match[2] !== sourceTitle) continue;
    const index = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(index)) highestNamedIndex = Math.max(highestNamedIndex, index);
  }
  const index = Math.max(children.length, highestNamedIndex) + 1;
  return `(${index}) ${sourceTitle}`;
}

async function ensureSessionFile(manager: SessionManager, sessionFile: string): Promise<void> {
  if (existsSync(sessionFile)) return;
  const header = manager.getHeader();
  if (!header) throw new Error("Forked session has no header");

  const contents = `${[
    JSON.stringify(header),
    ...manager.getEntries().map((entry) => JSON.stringify(entry)),
  ].join("\n")}\n`;
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  const temporaryFile = path.join(
    path.dirname(sessionFile),
    `.${path.basename(sessionFile)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryFile, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporaryFile, sessionFile);
  } catch (error) {
    await fs.unlink(temporaryFile).catch(() => undefined);
    throw error;
  }
}

async function createForkedSession(
  ctx: ExtensionCommandContext,
  sourceSessionFile: string,
  selectedEntryId: string,
): Promise<ForkedSession> {
  const selectedEntry = ctx.sessionManager.getEntry(selectedEntryId);
  if (selectedEntry?.type !== "message" || selectedEntry.message.role !== "user") {
    throw new Error("The selected message cannot be forked");
  }

  const title = await nextForkTitle(ctx, sourceSessionFile);
  const sessionDir = ctx.sessionManager.getSessionDir();
  const manager = selectedEntry.parentId
    ? SessionManager.open(sourceSessionFile, sessionDir)
    : SessionManager.create(ctx.cwd, sessionDir, { parentSession: sourceSessionFile });
  const sessionFile = selectedEntry.parentId
    ? manager.createBranchedSession(selectedEntry.parentId)
    : manager.getSessionFile();
  if (!sessionFile) throw new Error("Failed to create the forked session");

  manager.appendSessionInfo(title);
  await ensureSessionFile(manager, sessionFile);
  return { id: manager.getSessionId(), path: sessionFile, title };
}

function isManagedDraftFile(draftFile: string): boolean {
  const draftDir = path.dirname(path.resolve(draftFile));
  return (
    path.basename(draftFile) === DRAFT_FILE_NAME &&
    path.basename(draftDir).startsWith(DRAFT_DIR_PREFIX) &&
    path.dirname(draftDir) === path.resolve(tmpdir())
  );
}

async function createDraftFile(text: string): Promise<string> {
  const draftDir = await fs.mkdtemp(path.join(tmpdir(), DRAFT_DIR_PREFIX));
  const draftFile = path.join(draftDir, DRAFT_FILE_NAME);
  try {
    await fs.writeFile(draftFile, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return draftFile;
  } catch (error) {
    await fs.rm(draftDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readDraftFile(draftFile: string): Promise<string> {
  if (!isManagedDraftFile(draftFile)) throw new Error("Refusing to read an unmanaged fork draft");
  const draftDir = path.dirname(draftFile);
  const [directoryStat, fileStat] = await Promise.all([fs.lstat(draftDir), fs.lstat(draftFile)]);
  if (!directoryStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error("Fork draft path is not a regular private file");
  }
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (directoryStat.uid !== uid || fileStat.uid !== uid) {
      throw new Error("Fork draft is owned by another user");
    }
  }
  return fs.readFile(draftFile, "utf8");
}

async function removeDraftDirectory(draftFile: string): Promise<void> {
  if (!isManagedDraftFile(draftFile)) throw new Error("Refusing to delete an unmanaged fork draft");
  await fs.rm(path.dirname(draftFile), { recursive: true, force: true });
}

async function waitForDraftConsumption(draftFile: string): Promise<boolean> {
  const acknowledgement = path.join(path.dirname(draftFile), DRAFT_ACK_FILE_NAME);
  for (let attempt = 0; attempt < DRAFT_CONSUME_ATTEMPTS; attempt++) {
    if (existsSync(acknowledgement)) return true;
    await sleep(DRAFT_CONSUME_RETRY_MS);
  }
  return existsSync(acknowledgement);
}

async function removeSessionFile(sessionFile: string): Promise<void> {
  try {
    await fs.unlink(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function requestForkOpen(payload: ForkRequestPayload): Promise<void> {
  const socketPath = process.env.PI_VSCODE_STATUS_SOCKET;
  const token = process.env.PI_VSCODE_STATUS_TOKEN;
  if (!socketPath || !token)
    return Promise.reject(new ForkRequestError("VS Code bridge is unavailable", false));

  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let response = "";
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(
      () => finish(new ForkRequestError("Timed out waiting for VS Code", sent)),
      REQUEST_TIMEOUT_MS,
    );

    const finish = (error?: ForkRequestError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(new ForkRequestError(errorMessage(error), sent)));
    socket.once("close", () => {
      if (!settled) finish(new ForkRequestError("VS Code closed the fork request", sent));
    });
    socket.once("connect", () => {
      sent = true;
      socket.write(`${JSON.stringify({ type: "pi-vscode-fork", token, ...payload })}\n`);
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
        finish(new ForkRequestError("VS Code returned an oversized response", sent));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const result = JSON.parse(response.slice(0, newline)) as {
          type?: unknown;
          requestId?: unknown;
          ok?: unknown;
          error?: unknown;
        };
        if (result.type !== "pi-vscode-fork-result" || result.requestId !== payload.requestId) {
          throw new Error("VS Code returned an invalid fork response");
        }
        if (result.ok === true) finish();
        else {
          const reason =
            typeof result.error === "string" && result.error
              ? result.error
              : "VS Code rejected the fork";
          finish(new ForkRequestError(reason, false));
        }
      } catch (error) {
        finish(new ForkRequestError(errorMessage(error), sent));
      }
    });
  });
}

function commandState(
  ctx: ExtensionCommandContext,
):
  | { sourceSessionFile: string; sourceSessionId: string; tabId: string; messages: ForkMessage[] }
  | undefined {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/fork-with-vscode requires Pi interactive mode.", "error");
    return undefined;
  }
  const tabId = process.env.PI_VSCODE_STATUS_TAB_ID;
  if (!process.env.PI_VSCODE_STATUS_SOCKET || !process.env.PI_VSCODE_STATUS_TOKEN || !tabId) {
    ctx.ui.notify("/fork-with-vscode requires a session opened by Pi for VS Code.", "error");
    return undefined;
  }
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  if (!sourceSessionFile || !existsSync(sourceSessionFile)) {
    ctx.ui.notify("Send a message before forking this session.", "warning");
    return undefined;
  }
  const messages = forkMessages(ctx);
  if (messages.length === 0) {
    ctx.ui.notify("No historical user messages to fork from.", "warning");
    return undefined;
  }
  return {
    sourceSessionFile,
    sourceSessionId: ctx.sessionManager.getSessionId(),
    tabId,
    messages,
  };
}

async function runForkWithVSCode(ctx: ExtensionCommandContext): Promise<void> {
  const state = commandState(ctx);
  if (!state) return;
  const selected = await chooseForkMessage(ctx, state.messages);
  if (!selected) return;

  let forked: ForkedSession | undefined;
  let draftFile: string | undefined;
  try {
    forked = await createForkedSession(ctx, state.sourceSessionFile, selected.entryId);
    draftFile = await createDraftFile(selected.text);
    await requestForkOpen({
      requestId: randomUUID(),
      tabId: state.tabId,
      sourceSessionId: state.sourceSessionId,
      sessionId: forked.id,
      sessionPath: forked.path,
      draftFile,
    });

    if (await waitForDraftConsumption(draftFile)) {
      await removeDraftDirectory(draftFile);
      ctx.ui.notify(`Opened ${forked.title} in a new VS Code session.`, "info");
    } else {
      ctx.ui.notify(
        `Opened ${forked.title}, but its selected message has not been restored yet; the draft was kept at ${draftFile}.`,
        "warning",
      );
    }
  } catch (error) {
    const targetMayExist = error instanceof ForkRequestError && error.targetMayExist;
    const cleanupErrors: string[] = [];
    if (!targetMayExist && draftFile) {
      try {
        await removeDraftDirectory(draftFile);
      } catch (cleanupError) {
        cleanupErrors.push(`draft cleanup failed: ${errorMessage(cleanupError)}`);
      }
    }
    if (!targetMayExist && forked) {
      try {
        await removeSessionFile(forked.path);
      } catch (cleanupError) {
        cleanupErrors.push(`session cleanup failed: ${errorMessage(cleanupError)}`);
      }
    }
    const kept = targetMayExist && forked ? `; session kept at ${forked.path}` : "";
    const cleanup = cleanupErrors.length > 0 ? `; ${cleanupErrors.join("; ")}` : "";
    ctx.ui.notify(
      `Failed to open fork in VS Code: ${errorMessage(error)}${kept}${cleanup}`,
      "error",
    );
  }
}

export default function forkWithVSCode(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const draftFile = process.env[DRAFT_FILE_ENV];
    delete process.env[DRAFT_FILE_ENV];
    if (!draftFile) return;

    let draftRead = false;
    try {
      const draft = await readDraftFile(draftFile);
      draftRead = true;
      if (ctx.mode !== "tui") throw new Error("Fork draft requires Pi interactive mode");
      ctx.ui.setEditorText(draft);
      await fs.unlink(draftFile);
      await fs.writeFile(path.join(path.dirname(draftFile), DRAFT_ACK_FILE_NAME), "consumed\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (draftRead) await fs.unlink(draftFile).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && ctx.hasUI) {
        ctx.ui.notify(`Failed to restore fork draft: ${errorMessage(error)}`, "error");
      }
    }
  });

  pi.registerCommand("fork-with-vscode", {
    description:
      "Fork from a historical user message into a new Pi for VS Code session, then switch to it with the selected message left in the input box.",
    handler: async (_args, ctx) => {
      await runForkWithVSCode(ctx);
    },
  });
}
