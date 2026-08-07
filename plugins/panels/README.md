# pi-vscode-panels

Panel orchestration for Pi sessions running inside the [Pi VS Code extension](https://github.com/dcalsky/pi-vscode): one Pi session can spawn sibling sessions in background tabs and drive them — prompt, wait for completion, list — the way the herdr CLI lets an agent drive neighboring panes.

## Install

```bash
pi install npm:pi-vscode-panels

# or from a checkout of the pi-vscode repo
pi install ./plugins/panels
```

The package loads in every Pi session but registers its tools only in sessions started by the Pi VS Code extension (`PI_VSCODE_STATUS_*` env present). Elsewhere it is inert.

## Tools

| Tool | Purpose |
| --- | --- |
| `panel_create` | Open a sibling Pi in a background tab (no focus steal); optional `model` picks the panel's model (any `pi --model` pattern, e.g. `"openai/gpt-5:high"`). Resolves once its Pi is ready. Returns the `tabId`. |
| `panel_prompt` | Submit a prompt to a panel (bracketed paste + Enter; newlines stay literal). Returns immediately. |
| `panel_wait` | Block until a panel goes idle, with stall detection and a configurable timeout. Pass `tabIds` to wait for several panels at once (fan-in). |
| `panel_list` | List all Pi sessions in the window with tabId, title, and state; the caller is marked `self`. |

Panels share the workspace filesystem, so agents exchange briefs and results through files (for example `review/<topic>/a.md`). The bundled **pi-panels** skill teaches Pi the full review → human check → fix → verify loop.

## Develop

Maintained per the [pi-package-template](https://github.com/S1M0N38/pi-package-template) conventions: no build step (pi loads `.ts` via jiti), pi core packages are `peerDependencies` with `"*"`.

```bash
npm install
npm run typecheck

# smoke-test the tools (inside the Pi VS Code extension)
pi -ne -e . --no-session -p "Call the panel_list tool. You MUST use the panel_list tool."
```
