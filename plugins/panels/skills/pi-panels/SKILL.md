---
name: pi-panels
description: "Orchestrate sibling Pi sessions (panels) inside the Pi VS Code extension: fan out reviews to parallel agents, collect file-based results, and run fix/verify loops with a human checkpoint. Use when the user asks for multi-agent, panel, or parallel review/fix workflows while running inside the Pi VS Code view."
---

# Pi Panels

The Pi VS Code extension gives every Pi session four tools — `panel_create`, `panel_prompt`, `panel_wait`, `panel_list` — to spawn and drive sibling Pi sessions, each in its own tab of the Pi view.

Before orchestrating, verify the tools work:

```
panel_list()
```

If that errors, this session is not running inside the Pi VS Code extension; say so and stop.

## Conventions

- Panels are plain Pi sessions in the same workspace and cwd. They share the filesystem, so **all briefs and results are files**. Pick a working directory up front (for example `review/<topic>/`) and name every file explicitly in the prompts.
- Keep prompts short: role, which files to read, which file to write, and the required output shape. Long briefs go in a brief file, not the prompt.
- `panel_create` opens in the background and returns once the panel's Pi is ready. It returns a `tabId`; remember which tabId plays which role. Pass `model` to give a panel a different model (any `pi --model` pattern). To start several panels at once, emit one `panel_create` call per panel in a single message.
- `panel_prompt` returns immediately. Prompt every panel first, then call `panel_wait` once with `tabIds` — the panels work in parallel while you wait for all of them.
- `panel_wait` blocks until the panel (or every panel in `tabIds`) is idle. Give reviews and fixes generous timeouts (10–30 minutes). On timeout, wait again rather than re-prompting.
- A `panel_wait` stall error means the prompt never started a turn: the panel is busy or showing a dialog. Tell the user, do not blindly retry.
- The user watches all tabs live. Never close, stop, or delete sessions you did not create.

## Review → fix → verify loop

The canonical flow (the user may name different roles; codex/kimi/deepseek below are examples):

1. **Review yourself.** Do your own review of the target and write it to `review/<topic>/main.md`.
2. **Fan out.** `panel_create` twice — optionally with different `model`s (e.g. one Anthropic, one OpenAI) — for reviewer A and reviewer B. Emit both create calls in one message so the panels start in parallel. Prompt each: read the target (and your `main.md` if useful), review independently, write findings to `review/<topic>/a.md` / `b.md`. Prompt both, then `panel_wait` once with `tabIds` to block until both finish.
3. **Summarize.** Read `a.md` and `b.md`, merge with your own findings into `review/<topic>/summary.md`: deduplicated findings, each with severity and file:line.
4. **Human checkpoint.** Stop and show the summary to the user. Ask which findings to fix. This is the one step that must not be automated.
5. **Fix.** `panel_prompt` the fixer panel (e.g. A): apply the approved fixes from `summary.md`, then write what changed to `review/<topic>/fix-<n>.md`. `panel_wait` for it.
6. **Verify.** `panel_prompt` the verifier panel (e.g. B, or do it yourself): check the fixes in `fix-<n>.md` against `summary.md`, run the relevant checks, write a verdict to `review/<topic>/verify-<n>.md`. `panel_wait`, then read the verdict.
7. **Loop.** If verify found problems, go to step 5 with the new findings, incrementing `<n>`. Stop when verify is clean, then summarize the whole round for the user.

## Notes

- Panels do not see each other's chat history — only files and git state are shared. Anything another panel must know must be written down.
- Two panels editing the same file concurrently will conflict; keep review (read-only) parallel and fixes sequential.
- `panel_list` shows every session with its state; the orchestrating session is marked `self`.
