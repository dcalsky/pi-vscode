# Pi for VS Code

Run [pi coding agent](https://pi.dev) sessions in VS Code. Each session is a real terminal in a tab inside the Secondary Side Bar, with a session list beside it.

![Pi for VS Code](snapshot1.jpg)

## Highlights

- **Live status per session.** Each entry shows what Pi is doing: a spinning blue glyph while it works, green when it is waiting for your input, gray when it is stopped. No need to keep a terminal in view to know whether the agent is still going.
- **Click paths to open files.** ⌘-click (Ctrl on Windows/Linux) any path Pi prints and it opens in the editor at the right line and column. Paths like `src/file.ts:12:3` and paths wrapped across two terminal rows work; copying wrapped text yields the path on a single line.
- **Session management.** Browse every session for the current workspace in the list, grouped by `Today` / `Yesterday` / `Last 7 Days` / `Last 30 Days` / `Older` / `Archive`. Resume, fork, rewind, archive, close, or delete sessions from the list or the terminal tab's context menu. Open tabs are remembered per workspace and reopened next time.
- **Audio cue.** A short tone plays when a session goes from working to waiting — so you can start a task, switch away, and get told when it is done or needs input.

## Session list

- One entry per session, newest first. The title is the latest `session_info.name` from the session's JSONL transcript; sessions without one show `New Session`.
- Click an entry to focus its open terminal, or to resume it from disk (`pi --session <file>`) if it is not running.
- Hover a session to see when it was last used and to **Archive** it. Archiving only moves the entry to the `Archive` group; Pi and any open tab keep running. The same button restores it.
- **Delete** asks for confirmation, then stops Pi, closes the tab, and erases the transcript and sidecar directory from `~/.pi/agent/sessions/--<cwd>--/`.
- Long groups collapse behind **More**; each group name collapses on click.
- Below ~460px the view scrolls sideways instead of dropping the list. Hide the list with the pane toggle to give Pi the full width.

## Terminal

- One xterm.js terminal per open session, with tabs, a **+** button, and an overflow menu in the header.
- The header also has **Customize** (Pi settings), **Refresh**, and the pane toggle.
- **Close** (tab `×`, context menu, or `⌘W` / `Ctrl+F4` / `Ctrl+W`) hides the tab but leaves Pi running — the session keeps its live status and reopening it restores the scrollback. With no tab open, the shortcut closes the whole side bar.
- **Stop Pi** ends the process and closes the tab. The session stays listed and can be resumed.
- A tab closes itself when its Pi process exits; a non-zero exit shows a warning notification.
- Hold **⌘** (macOS) or **Ctrl** (Windows/Linux) and click a file path or HTTP(S) URL to open it. Source locations such as `src/file.ts:12:3` are honored.

## Use

1. Install and authenticate `pi` so `pi --version` works in VS Code's environment.
2. Open a folder in VS Code.
3. Click the Pi terminal icon in the editor's top-right toolbar (next to Run), or run **Pi: Open** from the Command Palette.

Pi opens in the Secondary Side Bar, reopens the sessions that were open for that folder last time, and offers **New session** / **+** to start one.

## Fork and Rewind

Right-click a finished session in the list or its terminal tab:

- **Fork** creates a sibling session from any earlier user message, opens it in a new tab, and leaves the selected message in the input box without submitting it.
- **Rewind** moves the same session back before the selected user message and leaves that message unsubmitted. If files changed since that point, choose whether to keep the current files or restore the exact tracked and non-ignored file state captured before the message.

Both actions are disabled while Pi is working. Rewind checkpoints use Git objects without changing the repository's real index.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `piAgent.command` | `pi` | Executable name or absolute path used to start pi. Set it when VS Code cannot find `pi` on its `PATH`. It is an executable path, not a command line with arguments. |

```json
{
  "piAgent.command": "/absolute/path/to/pi"
}
```

## Develop

```bash
npm install
npm test
npm run package
```

`npm run package` increments the patch version before creating the VSIX. Use **Run Extension** in VS Code to launch an Extension Development Host.
