# Wrapped Terminal Link MRE

An independent, minimal VS Code extension that verifies links crossing **xterm soft-wrap rows**.

It intentionally does not start Pi, use a PTY, or infer hard-wrapped Markdown lines. The fixture path and URL are each written to xterm as one logical line; xterm wraps them at 38 columns.

## Run

1. Install `wordwrap-link-mre-0.0.1.vsix`.
2. Run **Wrapped Link MRE: Open** from the Command Palette.
3. Confirm `Buffer check` says `PASS`.
4. Hover any fragment of the path or URL. Every visual row belonging to that link should underline.
5. Cmd/Ctrl-click either the first row or a continuation row. The file should open, or the example URL should be handed to the browser.

## Basis

- [VS Code issue #95077](https://github.com/microsoft/vscode/issues/95077) documents terminal word-link detection failing after wrapping.
- [xterm.js PR #3718](https://github.com/xtermjs/xterm.js/pull/3718) fixed wrapped web links by adjusting both start and end positions.
- The current [xterm.js WebLinkProvider](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-web-links/src/WebLinkProvider.ts) joins wrapped buffer rows, then maps string offsets back to buffer cells.

URLs use the official `@xterm/addon-web-links`. File paths use the same logical-line and cell-mapping approach in `media/wrapped-path-links.js`.
