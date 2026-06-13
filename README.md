# Window Deck

Window Deck is a VS Code multi-window navigator. It does not swap workspaces, reopen folders, migrate terminals, or touch debug sessions. It registers already-open VS Code windows, gives them searchable labels, and asks the operating system to focus a selected window.

## MVP Features

- Registers each VS Code window in a local registry with heartbeat and stale detection.
- Shows all known windows with `Window Deck: Show Windows`.
- Renames the current window with `Window Deck: Rename Current Window`.
- Sets a current-window color used by Window Deck UI.
- Adds a status bar entry for the current window.
- Detects local, SSH, WSL, Dev Container, Codespaces, and unknown remote windows.
- Best-effort focus support:
  - macOS: AppleScript fallback by matching the Window Deck title token.
  - Linux X11: `wmctrl` or `xdotool` fallback when installed.
  - Linux Wayland: indexing works; focus reports the platform limitation.
- Cleans stale entries with `Window Deck: Cleanup Stale Windows`.
- Reports platform focus support with `Window Deck: Diagnose Focus Support`.

## Development

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

## Release

The GitHub workflow in `.github/workflows/release.yml` packages the extension on pushes to `main`, creates or updates a tag named after `package.json` version, and uploads the `.vsix` file to a GitHub Release.

Before publishing, update these fields in `package.json`:

- `publisher`
- `repository.url`

The workflow needs the repository setting `Actions: Read and write permissions` enabled so `GITHUB_TOKEN` can create tags and releases.

## Notes

Automatic OS focusing is best-effort in this MVP. VS Code exposes `window.title` as configuration rather than a per-window runtime title API, so Window Deck does not automatically write a unique token into global settings.
