import * as vscode from "vscode";

import { Registry } from "./registry";
import { WindowRecord } from "./types";
import { applyStaleState } from "./windowMetadata";
import { compactPath, relativeAge, titleFromRecord } from "./util";

type ViewActions = {
  focusWindow(windowId: string): Promise<void>;
  renameWindow(windowId: string, alias: string): Promise<void>;
  setWindowColor(windowId: string, color: string): Promise<void>;
  refreshCurrentWindow(): Promise<void>;
};

export class WindowDeckViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "windowDeck.tabs";
  private view?: vscode.WebviewView;
  private refreshTimer?: NodeJS.Timeout;

  public constructor(
    private readonly registry: Registry,
    private readonly currentWindowId: () => string,
    private readonly staleAfterMs: () => number,
    private readonly actions: ViewActions
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = renderShell();
    webviewView.webview.onDidReceiveMessage((message: { type: string; windowId?: string; alias?: string; color?: string }) => {
      void this.handleMessage(message);
    });
    webviewView.onDidDispose(() => {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
      }
    });
    void this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, 2000);
  }

  public async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }
    await this.actions.refreshCurrentWindow();
    const data = await this.registry.read();
    const windows = applyStaleState(data.windows, this.staleAfterMs(), this.currentWindowId()).sort((a, b) => {
      if (a.windowId === this.currentWindowId()) {
        return -1;
      }
      if (b.windowId === this.currentWindowId()) {
        return 1;
      }
      if (a.state.stale !== b.state.stale) {
        return a.state.stale ? 1 : -1;
      }
      return (b.state.lastFocusedAt ?? b.state.lastSeenAt) - (a.state.lastFocusedAt ?? a.state.lastSeenAt);
    });
    await this.view.webview.postMessage({
      type: "windows",
      windows: windows.map(toViewModel),
      currentWindowId: this.currentWindowId()
    });
  }

  private async handleMessage(message: { type: string; windowId?: string; alias?: string; color?: string }): Promise<void> {
    if (!message.windowId) {
      return;
    }
    if (message.type === "focus") {
      await this.actions.focusWindow(message.windowId);
    } else if (message.type === "rename" && message.alias !== undefined) {
      await this.actions.renameWindow(message.windowId, message.alias);
    } else if (message.type === "color" && message.color) {
      await this.actions.setWindowColor(message.windowId, message.color);
    }
    await this.refresh();
  }
}

function renderShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
      --gap: 8px;
      --radius: 6px;
    }
    body {
      margin: 0;
      padding: 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .deck {
      display: flex;
      flex-direction: column;
      gap: var(--gap);
    }
    .tab {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 42px;
      padding: 7px 8px;
      border: 1px solid var(--vscode-sideBarSectionHeader-border);
      border-radius: var(--radius);
      background: var(--vscode-list-inactiveSelectionBackground);
      cursor: pointer;
    }
    .tab.current {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .tab.stale {
      opacity: 0.55;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--tab-color);
    }
    .main {
      min-width: 0;
    }
    .alias {
      width: 100%;
      box-sizing: border-box;
      color: inherit;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 2px 4px;
      font: inherit;
      font-weight: 600;
    }
    .alias:focus {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      outline: none;
    }
    .meta {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.78;
      font-size: 11px;
      padding-left: 4px;
    }
    .swatches {
      display: grid;
      grid-template-columns: repeat(4, 16px);
      gap: 4px;
    }
    .swatch {
      width: 16px;
      height: 16px;
      border-radius: 4px;
      border: 1px solid var(--vscode-contrastBorder);
      background: var(--swatch);
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="deck" id="deck"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const colors = ["#4f8cff", "#2fb344", "#f59f00", "#e03131", "#9c36b5", "#0ca678", "#f76707", "#495057"];
    const deck = document.getElementById("deck");
    const editing = new Set();

    window.addEventListener("message", (event) => {
      if (event.data.type !== "windows") return;
      render(event.data.windows, event.data.currentWindowId);
    });

    function render(windows, currentWindowId) {
      const active = document.activeElement;
      const activeWindowId = active && active.classList && active.classList.contains("alias") ? active.dataset.windowId : undefined;
      if (activeWindowId && editing.has(activeWindowId)) {
        return;
      }
      deck.innerHTML = windows.length ? windows.map((record) => renderWindow(record, currentWindowId)).join("") : "<div>No windows registered yet.</div>";

      document.querySelectorAll(".tab").forEach((tab) => {
        tab.addEventListener("click", (event) => {
          if (event.target.closest("input") || event.target.closest("button")) return;
          vscode.postMessage({ type: "focus", windowId: tab.dataset.windowId });
        });
      });
      document.querySelectorAll(".alias").forEach((input) => {
        const send = () => {
          editing.delete(input.dataset.windowId);
          vscode.postMessage({ type: "rename", windowId: input.dataset.windowId, alias: input.value.trim() });
        };
        input.addEventListener("focus", () => editing.add(input.dataset.windowId));
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            input.blur();
            send();
          }
        });
        input.addEventListener("blur", send);
        if (input.dataset.windowId === activeWindowId) {
          input.focus();
        }
      });
      document.querySelectorAll(".swatch").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: "color", windowId: button.dataset.windowId, color: button.dataset.color });
        });
      });
    }

    function renderWindow(record, currentWindowId) {
      const classes = ["tab", record.windowId === currentWindowId ? "current" : "", record.stale ? "stale" : ""].filter(Boolean).join(" ");
      const swatches = colors.map((item) =>
        '<button class="swatch" title="' + escapeHtml(item) + '" data-window-id="' + escapeHtml(record.windowId) + '" data-color="' + escapeHtml(item) + '" style="--swatch:' + escapeHtml(item) + '"></button>'
      ).join("");
      return '<div class="' + classes + '" data-window-id="' + escapeHtml(record.windowId) + '" style="--tab-color:' + escapeHtml(record.color) + '">' +
        '<div class="dot"></div>' +
        '<div class="main">' +
        '<input class="alias" data-window-id="' + escapeHtml(record.windowId) + '" value="' + escapeHtml(record.title) + '" aria-label="Window alias">' +
        '<div class="meta">' + escapeHtml(record.meta) + '</div>' +
        '</div>' +
        '<div class="swatches">' + swatches + '</div>' +
        '</div>';
    }

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
  </script>
</body>
</html>`;
}

function toViewModel(record: WindowRecord): Record<string, string | boolean> {
  const title = titleFromRecord(record.alias, record.workspaceName);
  const meta = [remoteLabel(record), compactPath(record.workspaceUri), record.git?.branch, record.state.stale ? "stale" : `active ${relativeAge(record.state.lastSeenAt)}`]
    .filter(Boolean)
    .join(" · ");
  return {
    windowId: record.windowId,
    title,
    color: record.color ?? "#4f8cff",
    meta,
    stale: record.state.stale
  };
}

function remoteLabel(record: WindowRecord): string {
  if (record.remote.kind === "local") {
    return "local";
  }
  if (record.remote.kind === "ssh") {
    return `ssh:${authorityName(record.remote.remoteAuthority)}`;
  }
  if (record.remote.kind === "dev-container") {
    return "container";
  }
  if (record.remote.kind === "wsl") {
    return `wsl:${authorityName(record.remote.remoteAuthority)}`;
  }
  return record.remote.kind;
}

function authorityName(authority?: string): string {
  if (!authority) {
    return "unknown";
  }
  return authority.split("+").pop() ?? authority;
}
