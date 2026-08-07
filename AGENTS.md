# Pi for VS Code — Agent Context

## Project Overview

VS Code extension that runs [pi](https://pi.dev) sessions in webview terminals (Secondary Side Bar), plus companion opt-in pi packages under `plugins/`.

**Tech Stack:** TypeScript (extension host, compiled with `tsc`), plain JS webview scripts (no build), node-pty, xterm.js.

### Layout

```
src/               # Extension host: sessions, status bridge, view state
media/             # Webview scripts (xterm.js tabs, session list) — no build step
resources/         # Pi extension auto-injected into every spawned session (status reporting)
plugins/           # Companion pi packages, one directory per package
  fork/            #   pi-vscode-fork (published on npm): /fork-with-vscode command
  panels/          #   pi-vscode-panels: panel orchestration tools + pi-panels skill
src/test/          # node:test suites; each file must be listed in package.json "test"
```

### Key Constraints

- **The status socket is the trust boundary** — `src/status-bridge.ts` authenticates every message with a per-instance token passed via env (`PI_VSCODE_STATUS_*`). New wire message types need validation there.
- **Bridge protocols have two sides, change both together**:
  - fork: `PiForkRequest` in `src/status-bridge.ts` + `handleForkRequest` in `src/extension.ts` ↔ `plugins/fork/extensions/index.ts`
  - panels: `PiPanelRequest` in `src/status-bridge.ts` + `handlePanelRequest` in `src/extension.ts` ↔ `plugins/panels/extensions/index.ts`
- **No focus steal** — anything opened programmatically in the webview must keep the user's current tab focused (see `noFocus` in `media/main.js`).
- Tests: `npm test` runs `tsc` first; add new suites to the `test` script explicitly.

---

## Plugin Standard (`plugins/`)

Every pi package is maintained per [pi-package-template](https://github.com/S1M0N38/pi-package-template). The rules that matter here:

- **One package per directory** — `plugins/<name>/` is a self-contained pi package with its own `package.json` (pi manifest, version, publish config), `extensions/index.ts` (default-export factory, `ExtensionAPI`, `Type.Object` schemas from typebox), optional `skills/<name>/SKILL.md`, `tsconfig.json` (typecheck only), and README. New plugins get a new sibling directory — do not merge two plugins into one package.
- **No build step** — pi loads `.ts` via jiti. Never add compilation to a plugin.
- **Peer deps** — `@earendil-works/pi-*` and `typebox` are `peerDependencies` with `"*"` range; pi provides them at runtime. Runtime npm deps go in `dependencies`, never `devDependencies`.
- **Env gating** — a plugin must stay inert outside VS Code-hosted sessions (check `PI_VSCODE_STATUS_*` before registering tools/commands).
- **Verify per package** — `cd plugins/<name> && npm run typecheck` (fork also has `npm run lint` via biome), then smoke-test in print mode:
  ```bash
  pi -ne -e ./plugins/<name> --no-session -p "List the tools you have available."
  ```
  (`-ne` isolates the package from globally installed extensions.)
- **Install for users** — `pi install ./plugins/<name>` from a repo checkout, or `pi install npm:<name>` after `npm publish` from that directory.
- **Versioning is per package** — bump `plugins/<name>/package.json` and publish from that directory; the VS Code extension versions independently in the root `package.json`.

Notes:

- `plugins/fork` was absorbed from the standalone `pi-vscode-fork` repo (now an archive); its history lives there. Develop it here.
- Skipped from the template except where already present: biome (fork has it, panels does not), themes/prompts dirs, release-please CI, per-repo CHANGELOG.

---

## Git Conventions

- Imperative commit summaries; append `release X.Y.Z` when bumping the VS Code extension version. See `git log`.

## Release

**VS Code extension** — one-time auth: `npx @vscode/vsce login EthanChow` (Azure DevOps PAT) or set `VSCE_PAT`. Then:

```bash
npx @vscode/vsce publish patch            # bump + compile + publish to the marketplace
# or, if `npm run package` already bumped the version:
npx @vscode/vsce publish                  # publish the version in package.json
git commit -am "..., release X.Y.Z"        # after a successful publish
```

**pi packages** — per package, from its own directory:

```bash
cd plugins/<name>
npm version patch && npm publish
```

Publishing requires a browser 2FA confirmation on this account; run `npm publish` in a real terminal — the auth URL is masked (`***`) on non-TTY output.

## Development Commands

```bash
npm test                                # root: compile + all node:test suites
npm run package                         # root: version bump + vsix
cd plugins/panels && npm run typecheck  # panels: type check
cd plugins/fork && npm test             # fork: type check + biome lint
```
