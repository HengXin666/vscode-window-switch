import * as vscode from "vscode";

import { Registry } from "./registry";
import { WindowDeckLayout, WindowRecord } from "./types";
import { applyStaleState } from "./windowMetadata";
import { compactPath, relativeAge, titleFromRecord } from "./util";

type PanelActions = {
  focusWindow(windowId: string): Promise<void>;
  openWindow(windowId: string): Promise<void>;
  renameWindow(windowId: string, alias: string): Promise<void>;
  setWindowColor(windowId: string, color: string): Promise<void>;
  removeWindow(windowId: string): Promise<void>;
  saveLayout(layout: WindowDeckLayout): Promise<void>;
  refreshCurrentWindow(): Promise<void>;
};

type PanelMessage = {
  type: string;
  windowId?: string;
  alias?: string;
  color?: string;
  layout?: WindowDeckLayout;
};

export class WindowDeckPanel {
  private panel?: vscode.WebviewPanel;
  private refreshTimer?: NodeJS.Timeout;

  public constructor(
    private readonly registry: Registry,
    private readonly currentWindowId: () => string,
    private readonly staleAfterMs: () => number,
    private readonly actions: PanelActions
  ) {}

  public async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, true);
      await this.refresh();
      return;
    }
    this.panel = vscode.window.createWebviewPanel("windowDeck.panel", "Window Deck", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    this.panel.webview.html = renderShell();
    this.panel.webview.onDidReceiveMessage((message: PanelMessage) => {
      void this.handleMessage(message);
    });
    this.panel.onDidDispose(() => {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
      }
      this.panel = undefined;
    });
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, 2000);
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    if (!this.panel) {
      return;
    }
    await this.actions.refreshCurrentWindow();
    const data = await this.registry.read();
    const staleAware = applyStaleState(data.windows, this.staleAfterMs(), this.currentWindowId());
    const ordered = orderWindows(staleAware, data.layout.order);
    await this.panel.webview.postMessage({
      type: "windows",
      windows: ordered.map(toViewModel),
      layout: data.layout,
      currentWindowId: this.currentWindowId()
    });
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    if (message.type === "layout" && message.layout) {
      await this.actions.saveLayout(message.layout);
    } else if (message.windowId && message.type === "focus") {
      await this.actions.focusWindow(message.windowId);
    } else if (message.windowId && message.type === "open") {
      await this.actions.openWindow(message.windowId);
    } else if (message.windowId && message.type === "remove") {
      await this.actions.removeWindow(message.windowId);
    } else if (message.windowId && message.type === "rename" && message.alias !== undefined) {
      await this.actions.renameWindow(message.windowId, message.alias);
    } else if (message.windowId && message.type === "color" && message.color) {
      await this.actions.setWindowColor(message.windowId, message.color);
    }
    await this.refresh();
  }
}

function orderWindows(windows: WindowRecord[], order: string[]): WindowRecord[] {
  const index = new Map(order.map((windowId, position) => [windowId, position]));
  return [...windows].sort((a, b) => {
    const aIndex = index.get(a.windowId) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = index.get(b.windowId) ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }
    if (a.state.stale !== b.state.stale) {
      return a.state.stale ? 1 : -1;
    }
    return (b.state.lastFocusedAt ?? b.state.lastSeenAt) - (a.state.lastFocusedAt ?? a.state.lastSeenAt);
  });
}

function renderShell(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
      --radius: 6px;
    }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 34px;
      padding: 0 10px;
      border-bottom: 1px solid var(--vscode-editorGroup-border);
      background: var(--vscode-editor-background);
    }
    .title {
      font-weight: 600;
    }
    .hint {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .deck {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 10px;
      overflow-x: auto;
      min-height: 96px;
    }
    .tab, .group {
      flex: 0 0 auto;
    }
    .tab {
      display: grid;
      grid-template-columns: 10px minmax(90px, 1fr) auto;
      gap: 7px;
      align-items: center;
      width: 220px;
      min-height: 34px;
      padding: 5px 7px;
      border: 1px solid var(--vscode-editorGroup-border);
      border-radius: var(--radius);
      background: var(--vscode-tab-inactiveBackground);
      cursor: pointer;
      user-select: none;
    }
    .tab.current {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-tab-activeBackground);
    }
    .tab.stale {
      opacity: 0.62;
      border-style: dashed;
    }
    .tab.drop-before {
      box-shadow: -3px 0 0 var(--vscode-focusBorder);
    }
    .tab.drop-merge {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--tab-color);
    }
    .alias {
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
      color: inherit;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 1px 3px;
      font: inherit;
      font-weight: 600;
    }
    .alias:focus {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      outline: none;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .icon {
      width: 18px;
      height: 18px;
      border: 0;
      border-radius: 4px;
      color: inherit;
      background: transparent;
      cursor: pointer;
    }
    .icon:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    .menu {
      display: none;
      position: fixed;
      z-index: 5;
      grid-template-columns: repeat(4, 18px);
      gap: 5px;
      padding: 6px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: var(--radius);
      background: var(--vscode-dropdown-background);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    }
    .menu.open {
      display: grid;
    }
    .swatch {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      border: 1px solid var(--vscode-contrastBorder);
      background: var(--swatch);
      cursor: pointer;
    }
    .group {
      min-width: 250px;
      max-width: 520px;
      border: 1px solid var(--vscode-editorGroup-border);
      border-radius: var(--radius);
      background: var(--vscode-sideBar-background);
    }
    .group.drop-before {
      box-shadow: -3px 0 0 var(--vscode-focusBorder);
    }
    .group-head {
      display: flex;
      align-items: center;
      gap: 7px;
      min-height: 32px;
      padding: 4px 7px;
      cursor: pointer;
      user-select: none;
    }
    .group-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .group-items {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 7px;
      border-top: 1px solid var(--vscode-editorGroup-border);
    }
    .group.collapsed .group-items {
      display: none;
    }
    .group .tab {
      width: 218px;
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      padding: 14px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="title">Window Deck</span>
    <span class="hint">点击切换；失联窗口点标题可重新打开，点 x 删除；拖拽排序，拖到另一个标签上创建分组。</span>
  </div>
  <div class="deck" id="deck"></div>
  <div class="menu" id="colorMenu"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const colors = ["#4f8cff", "#2fb344", "#f59f00", "#e03131", "#9c36b5", "#0ca678", "#f76707", "#495057"];
    const deck = document.getElementById("deck");
    const colorMenu = document.getElementById("colorMenu");
    let windows = [];
    let layout = { order: [], groups: [] };
    let currentWindowId = "";
    let draggedWindowId = "";
    let editingWindowId = "";

    window.addEventListener("message", (event) => {
      if (event.data.type !== "windows") return;
      if (editingWindowId) return;
      windows = event.data.windows || [];
      layout = normalizeLayout(event.data.layout || { order: [], groups: [] });
      currentWindowId = event.data.currentWindowId || "";
      render();
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest("#colorMenu") && !event.target.closest(".color-button")) {
        colorMenu.classList.remove("open");
      }
    });

    function render() {
      const grouped = new Set(layout.groups.flatMap((group) => group.windowIds));
      const byId = new Map(windows.map((item) => [item.windowId, item]));
      const parts = [];
      for (const id of layout.order) {
        const group = layout.groups.find((item) => item.windowIds[0] === id);
        if (group) {
          parts.push(renderGroup(group, byId));
          continue;
        }
        if (!grouped.has(id) && byId.has(id)) {
          parts.push(renderTab(byId.get(id)));
        }
      }
      for (const item of windows) {
        if (!layout.order.includes(item.windowId) && !grouped.has(item.windowId)) {
          parts.push(renderTab(item));
        }
      }
      deck.innerHTML = parts.length ? parts.join("") : '<div class="empty">还没有注册的 VS Code 窗口。</div>';
      bindEvents();
    }

    function renderGroup(group, byId) {
      const visible = group.windowIds.map((id) => byId.get(id)).filter(Boolean);
      const title = group.title || visible.map((item) => item.title).join(" / ") || "分组";
      return '<section class="group ' + (group.collapsed ? "collapsed" : "") + '" draggable="true" data-group-id="' + escapeHtml(group.id) + '">' +
        '<div class="group-head">' +
        '<button class="icon collapse" title="折叠/展开" data-group-id="' + escapeHtml(group.id) + '">' + (group.collapsed ? "›" : "⌄") + '</button>' +
        '<span class="dot" style="--tab-color:' + escapeHtml(group.color || "#4f8cff") + '"></span>' +
        '<span class="group-title">' + escapeHtml(title) + '</span>' +
        '<button class="icon ungroup" title="取消分组" data-group-id="' + escapeHtml(group.id) + '">×</button>' +
        '</div>' +
        '<div class="group-items">' + visible.map(renderTab).join("") + '</div>' +
        '</section>';
    }

    function renderTab(record) {
      const classes = ["tab", record.windowId === currentWindowId ? "current" : "", record.stale ? "stale" : ""].filter(Boolean).join(" ");
      return '<div class="' + classes + '" draggable="true" data-window-id="' + escapeHtml(record.windowId) + '">' +
        '<span class="dot" style="--tab-color:' + escapeHtml(record.color) + '"></span>' +
        '<input class="alias" data-window-id="' + escapeHtml(record.windowId) + '" value="' + escapeHtml(record.title) + '" title="' + escapeHtml(record.meta) + '">' +
        '<span class="actions">' +
        '<button class="icon color-button" title="颜色" data-window-id="' + escapeHtml(record.windowId) + '">●</button>' +
        (record.stale ? '<button class="icon close" title="删除记录" data-window-id="' + escapeHtml(record.windowId) + '">×</button>' : '') +
        '</span>' +
        '</div>';
    }

    function bindEvents() {
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.addEventListener("click", (event) => {
          if (event.target.closest("input") || event.target.closest("button")) return;
          const record = findWindow(tab.dataset.windowId);
          vscode.postMessage({ type: record && record.stale ? "open" : "focus", windowId: tab.dataset.windowId });
        });
        tab.addEventListener("dragstart", (event) => {
          draggedWindowId = tab.dataset.windowId;
          event.dataTransfer.effectAllowed = "move";
        });
        tab.addEventListener("dragover", (event) => {
          if (!draggedWindowId || draggedWindowId === tab.dataset.windowId) return;
          event.preventDefault();
          tab.classList.toggle("drop-merge", event.offsetX > tab.clientWidth * 0.35 && event.offsetX < tab.clientWidth * 0.75);
          tab.classList.toggle("drop-before", event.offsetX <= tab.clientWidth * 0.35);
        });
        tab.addEventListener("dragleave", () => {
          tab.classList.remove("drop-merge", "drop-before");
        });
        tab.addEventListener("drop", (event) => {
          event.preventDefault();
          const targetWindowId = tab.dataset.windowId;
          const merge = event.offsetX > tab.clientWidth * 0.35 && event.offsetX < tab.clientWidth * 0.75;
          tab.classList.remove("drop-merge", "drop-before");
          if (merge) mergeWindows(draggedWindowId, targetWindowId);
          else moveBefore(draggedWindowId, targetWindowId);
          draggedWindowId = "";
          saveLayout();
          render();
        });
      });
      document.querySelectorAll(".group").forEach((group) => {
        group.addEventListener("dragstart", (event) => {
          event.dataTransfer.effectAllowed = "move";
          draggedWindowId = firstWindowInGroup(group.dataset.groupId);
        });
        group.addEventListener("dragover", (event) => {
          if (!draggedWindowId) return;
          event.preventDefault();
          group.classList.add("drop-before");
        });
        group.addEventListener("dragleave", () => group.classList.remove("drop-before"));
        group.addEventListener("drop", (event) => {
          event.preventDefault();
          group.classList.remove("drop-before");
          moveBefore(draggedWindowId, firstWindowInGroup(group.dataset.groupId));
          draggedWindowId = "";
          saveLayout();
          render();
        });
      });
      document.querySelectorAll(".alias").forEach((input) => {
        input.addEventListener("focus", () => editingWindowId = input.dataset.windowId);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") input.blur();
        });
        input.addEventListener("blur", () => {
          editingWindowId = "";
          vscode.postMessage({ type: "rename", windowId: input.dataset.windowId, alias: input.value.trim() });
        });
      });
      document.querySelectorAll(".color-button").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          showColorMenu(button.dataset.windowId, button.getBoundingClientRect());
        });
      });
      document.querySelectorAll(".close").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          removeFromLayout(button.dataset.windowId);
          vscode.postMessage({ type: "remove", windowId: button.dataset.windowId });
          render();
        });
      });
      document.querySelectorAll(".collapse").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const group = layout.groups.find((item) => item.id === button.dataset.groupId);
          if (group) group.collapsed = !group.collapsed;
          saveLayout();
          render();
        });
      });
      document.querySelectorAll(".ungroup").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const group = layout.groups.find((item) => item.id === button.dataset.groupId);
          layout.groups = layout.groups.filter((item) => item.id !== button.dataset.groupId);
          if (group) {
            const insertAt = Math.max(0, layout.order.indexOf(group.windowIds[0]));
            layout.order = layout.order.filter((id) => !group.windowIds.includes(id));
            layout.order.splice(insertAt, 0, ...group.windowIds);
          }
          saveLayout();
          render();
        });
      });
    }

    function showColorMenu(windowId, rect) {
      colorMenu.innerHTML = colors.map((color) =>
        '<button class="swatch" style="--swatch:' + escapeHtml(color) + '" data-window-id="' + escapeHtml(windowId) + '" data-color="' + escapeHtml(color) + '"></button>'
      ).join("");
      colorMenu.style.left = Math.min(rect.left, window.innerWidth - 120) + "px";
      colorMenu.style.top = (rect.bottom + 4) + "px";
      colorMenu.classList.add("open");
      colorMenu.querySelectorAll(".swatch").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: "color", windowId: button.dataset.windowId, color: button.dataset.color });
          colorMenu.classList.remove("open");
        });
      });
    }

    function normalizeLayout(next) {
      const ids = windows.map((item) => item.windowId);
      const seen = new Set();
      const order = (next.order || []).filter((id) => ids.includes(id) && !seen.has(id) && seen.add(id));
      ids.forEach((id) => { if (!seen.has(id)) order.push(id); });
      const groups = (next.groups || []).map((group) => ({
        id: group.id,
        title: group.title || "分组",
        color: group.color,
        collapsed: Boolean(group.collapsed),
        windowIds: (group.windowIds || []).filter((id) => ids.includes(id))
      })).filter((group) => group.windowIds.length > 0);
      return { order, groups };
    }

    function moveBefore(sourceId, targetId) {
      if (!sourceId || !targetId || sourceId === targetId) return;
      removeFromGroups(sourceId);
      layout.order = layout.order.filter((id) => id !== sourceId);
      const index = Math.max(0, layout.order.indexOf(targetId));
      layout.order.splice(index, 0, sourceId);
    }

    function mergeWindows(sourceId, targetId) {
      if (!sourceId || !targetId || sourceId === targetId) return;
      const existing = layout.groups.find((group) => group.windowIds.includes(targetId));
      removeFromGroups(sourceId);
      if (existing) {
        existing.windowIds = [...new Set([...existing.windowIds, sourceId])];
      } else {
        const source = findWindow(sourceId);
        const target = findWindow(targetId);
        const group = {
          id: "group-" + Date.now().toString(36),
          title: [target && target.title, source && source.title].filter(Boolean).join(" / "),
          color: target && target.color,
          collapsed: false,
          windowIds: [targetId, sourceId]
        };
        layout.groups.push(group);
      }
      layout.order = layout.order.filter((id) => id !== sourceId);
      if (!layout.order.includes(targetId)) layout.order.push(targetId);
    }

    function removeFromGroups(windowId) {
      layout.groups = layout.groups.map((group) => ({
        ...group,
        windowIds: group.windowIds.filter((id) => id !== windowId)
      })).filter((group) => group.windowIds.length > 0);
    }

    function removeFromLayout(windowId) {
      layout.order = layout.order.filter((id) => id !== windowId);
      removeFromGroups(windowId);
      saveLayout();
    }

    function firstWindowInGroup(groupId) {
      const group = layout.groups.find((item) => item.id === groupId);
      return group && group.windowIds[0] || "";
    }

    function findWindow(windowId) {
      return windows.find((item) => item.windowId === windowId);
    }

    function saveLayout() {
      layout = normalizeLayout(layout);
      vscode.postMessage({ type: "layout", layout });
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
  const meta = [remoteLabel(record), compactPath(record.workspaceUri), record.git?.branch, record.state.stale ? "已失联" : `活跃于 ${relativeAge(record.state.lastSeenAt)}`]
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
    return "本地";
  }
  if (record.remote.kind === "ssh") {
    return `SSH:${authorityName(record.remote.remoteAuthority)}`;
  }
  if (record.remote.kind === "dev-container") {
    return "容器";
  }
  if (record.remote.kind === "wsl") {
    return `WSL:${authorityName(record.remote.remoteAuthority)}`;
  }
  return record.remote.kind;
}

function authorityName(authority?: string): string {
  if (!authority) {
    return "未知";
  }
  return authority.split("+").pop() ?? authority;
}
