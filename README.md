# Pi for VS Code

Run [pi coding agent](https://pi.dev) inside VS Code, in a real terminal in the Secondary Side Bar.

- **Keep several sessions open at once.** Each session gets its own tab, and the list beside them holds every session for this folder, newest first. Click one to jump to it, or to resume it from disk if it is no longer running. Which tabs were open is remembered per folder and reopened next time. It is the session list you know from Cursor and Copilot, over Pi's own transcripts on disk.
- **See which sessions are working.** Every entry carries a live glyph: spinning blue while Pi is working, green when it is idle and waiting on you, gray when it is not running. A short tone plays the moment a session goes idle, so you can start one, switch away, and be told when it wants you back.
- **Open the files Pi mentions.** ⌘-click (Ctrl on Windows and Linux) any path Pi prints and it opens in the editor, on the right line and column. Paths Pi wrapped across two rows work too, and copying wrapped text gives you the path back in one piece.

## What you get

- **Left pane:** one xterm.js terminal per open Pi session, with its tabs, **+** and an overflow menu in the header.
- **Right pane:** header icons for **Customize** (Pi settings), **Refresh** and the pane toggle, then search, **New session**, and the workspace's sessions grouped as `Today` / `Yesterday` / `Last 7 Days` / `Last 30 Days` / `Older` / `Archive` by last write. Long groups collapse behind **More**, and each group name collapses on click—hovering it reveals a chevron. The latest JSONL `session_info.name` is the title; sessions without one display `New Session`. A left-hand glyph updates live: spinning blue = working, green = idle, gray = not open.
- **Audio cue:** a short tone plays when a Pi session goes from working to idle—when it has completed or needs the next human action.
- **Hovering a session** reveals how long ago it was last used and an **Archive** button that files it under `Archive`; archiving only moves the list entry, leaving Pi and any open tab alone. The same button restores it.
- Open sessions and the focused one are remembered per workspace and reopened (`pi --session <file>`) the next time that folder is opened. Archived sessions and closed tabs are not reopened.
- Use **New session** or **+** to start a session. `×`, **Close** in either context menu, and the platform's **Close Editor** shortcut (`⌘W` on macOS, `Ctrl+F4` on Windows, `Ctrl+W` on Linux) close the tab but leave Pi running—the session keeps its live status in the list, and selecting it brings the tab back with its scrollback. Once no tab is open, the shortcut closes Pi's secondary side bar.
- **Stop Pi** in either context menu ends the Pi process and closes its tab. It is offered only while a session has a live process; the session itself stays in the list and can be resumed from disk.
- **Delete** in either context menu asks for confirmation, then stops Pi, closes the tab and erases the session's transcript and sidecar directory from `~/.pi/agent/sessions/--<cwd>--/`. The session leaves the tab bar and the list for good.
- A tab closes on its own when its Pi process exits; a non-zero exit is reported as a warning notification.
- Clicking a saved session focuses its existing terminal or starts `pi --session <file>`.
- Below about 460px the view scrolls sideways rather than dropping the session list; hide the list with the pane toggle to use Pi in a narrower side bar.
- Hold **⌘** (macOS) or **Ctrl** (Windows/Linux) and click a file path or HTTP(S) URL to open it. Source locations such as `src/file.ts:12:3` are respected.
- Copying text Pi word-wrapped across rows puts it back on one line—no newline where Pi split a word, a single space where it wrapped between words. Blank rows, list items, quotes and code fences keep their line breaks.

Pi stores current sessions in `~/.pi/agent/sessions/--<cwd>--/`. The extension also reads the legacy singular `session/` directory. It filters JSONL headers by `cwd`, so only the open workspace's sessions appear. It loads its bundled status extension per Pi process with `--extension`; it does not modify your `~/.pi` configuration.

## Use

1. Install and authenticate `pi`; `pi --version` must work in VS Code's environment.
2. Open a folder in VS Code.
3. Click the Pi terminal icon in the editor's top-right toolbar (next to Run), or run **Pi: Open** from the Command Palette.

Pi opens in the Secondary Side Bar and reopens the sessions that were open for that folder last time, or starts a new one rooted there. A tab's title follows the latest `session_info.name`, or `New Session` until one is saved.

If VS Code cannot find `pi`, set `piAgent.command` to the executable's absolute path (it is an executable path, not a command line with arguments):

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
