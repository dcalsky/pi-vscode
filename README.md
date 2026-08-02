# Pi for VS Code

A small local VS Code extension for running [pi coding agent](https://pi.dev) sessions in an embedded terminal.

- **Left 3/4:** one xterm.js terminal per open Pi session, with synchronized tabs above it.
- **Right 1/4:** current and saved sessions for the active workspace, grouped as `Last 30 days` / `Older` by creation date. The latest JSONL `session_info.name` is the title; sessions without one display `New Session`. A left-hand glyph updates live: spinning blue = working, green = idle, gray = not open.
- **Audio cue:** a short tone plays when a Pi session goes from working to idle—when it has completed or needs the next human action.
- Use either **New** button to start a session. `×` and the tab context menu hide a terminal without stopping Pi; select its session on the right to restore it. The history pane can be hidden and restored.
- With focus in Pi, the platform's usual **Close Editor** shortcut (`⌘W` on macOS, `Ctrl+F4` on Windows, `Ctrl+W` on Linux) hides the active terminal. Once no terminal is open, it closes Pi's secondary side bar.
- Clicking a saved session focuses its existing terminal or starts `pi --session <file>`.
- Hold **⌘** (macOS) or **Ctrl** (Windows/Linux) and click a file path or HTTP(S) URL to open it. Source locations such as `src/file.ts:12:3` are respected.

Pi stores current sessions in `~/.pi/agent/sessions/--<cwd>--/`. The extension also reads the legacy singular `session/` directory. It filters JSONL headers by `cwd`, so only the open workspace's sessions appear. It loads its bundled status extension per Pi process with `--extension`; it does not modify your `~/.pi` configuration.

## Use

1. Install and authenticate `pi`; `pi --version` must work in VS Code's environment.
2. Open a folder in VS Code.
3. Click the Pi terminal icon in the editor's top-right toolbar (next to Run), or run **Pi: Open** from the Command Palette.

Pi opens in the Secondary Side Bar and starts a new session rooted at that folder. Its title follows the latest `session_info.name`, or `New Session` until one is saved.

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
