import * as vscode from "vscode";

import { Registry } from "./registry";
import { WindowDeckLayout, WindowRecord } from "./types";
import { applyStaleState } from "./windowMetadata";
import { compactPath, relativeAge, titleFromRecord } from "./util";
import { normalizeVisibleLayout, orderVisibleRecords, visibleWindowRecords } from "./windowView";

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
    const visible = visibleWindowRecords(staleAware);
    const layout = normalizeVisibleLayout(data.layout, visible);
    const ordered = orderVisibleRecords(visible, layout);
    await this.panel.webview.postMessage({
      type: "windows",
      windows: ordered.map(toViewModel),
      layout,
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

function renderShell(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light dark; --radius: 6px; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .surface {
      width: min(620px, calc(100vw - 24px));
      margin: 12px auto;
      border: 1px solid var(--vscode-widget-border);
      border-radius: var(--radius);
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
      overflow: hidden;
    }
    .head {
      display: flex;
      align-items: center;
      min-height: 34px;
      padding: 0 10px;
      border-bottom: 1px solid var(--vscode-widget-border);
      background: var(--vscode-sideBar-background);
      font-weight: 600;
    }
    .list { max-height: calc(100vh - 90px); overflow: auto; padding: 6px; }
    .section { padding: 6px 6px 3px; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; }
    .row {
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 32px;
      padding: 5px 7px;
      margin: 2px 0;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      cursor: pointer;
      user-select: none;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.current {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .row.stale { opacity: .62; }
    .row.drop-before { box-shadow: 0 -2px 0 var(--vscode-focusBorder); }
    .row.drop-merge { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    .box {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      border: 1px solid color-mix(in srgb, var(--item-color), #000 18%);
      background: var(--item-color);
      box-sizing: border-box;
    }
    .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; margin-left: 7px; }
    .icon {
      width: 22px;
      height: 22px;
      border: 0;
      border-radius: 4px;
      color: inherit;
      background: transparent;
      cursor: pointer;
      line-height: 20px;
    }
    .icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    .group {
      margin: 3px 0;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 5px;
      overflow: hidden;
      background: var(--vscode-dropdown-background);
    }
    .group.drop-before { box-shadow: 0 -2px 0 var(--vscode-focusBorder); }
    .group.drop-into { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    .group-head {
      display: grid;
      grid-template-columns: 18px 12px minmax(0, 1fr) auto;
      gap: 7px;
      align-items: center;
      min-height: 30px;
      padding: 4px 7px;
      background: var(--vscode-sideBar-background);
      cursor: pointer;
      user-select: none;
    }
    .group-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .group.collapsed .group-body { display: none; }
    .group-body { padding: 3px 4px 4px; }
    .menu {
      position: fixed;
      z-index: 10;
      display: none;
      min-width: 188px;
      padding: 5px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: var(--radius);
      background: var(--vscode-dropdown-background);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
    }
    .menu.open { display: block; }
    .menu button {
      display: block;
      width: 100%;
      min-height: 27px;
      padding: 4px 8px;
      border: 0;
      border-radius: 4px;
      color: var(--vscode-dropdown-foreground);
      background: transparent;
      text-align: left;
      cursor: pointer;
    }
    .menu button:hover { background: var(--vscode-list-hoverBackground); }
    .palette { display: grid; grid-template-columns: repeat(8, 18px); gap: 5px; padding: 6px 4px 3px; }
    .swatch {
      width: 18px !important;
      min-height: 18px !important;
      padding: 0 !important;
      border: 1px solid var(--vscode-contrastBorder) !important;
      border-radius: 3px !important;
      background: var(--swatch) !important;
    }
    .empty { padding: 14px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <main class="surface">
    <div class="head">Window Deck</div>
    <div class="list" id="deck"></div>
  </main>
  <div class="menu" id="menu"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const COLORS = ["#4f8cff", "#2fb344", "#f59f00", "#e03131", "#9c36b5", "#0ca678", "#f76707", "#495057"];
    const deck = document.getElementById("deck");
    const menu = document.getElementById("menu");
    let windows = [];
    let layout = { order: [], groups: [] };
    let currentWindowId = "";
    let dragState = null;

    window.addEventListener("message", (event) => {
      if (event.data.type !== "windows") return;
      windows = event.data.windows || [];
      layout = normalizeLayout(event.data.layout || { order: [], groups: [] });
      currentWindowId = event.data.currentWindowId || "";
      render();
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#menu")) menu.classList.remove("open");
    }, true);

    function render() {
      layout = normalizeLayout(layout);
      const active = renderSection(false);
      const stale = renderSection(true);
      deck.innerHTML = active + stale || '<div class="empty">没有已注册的工作区窗口。</div>';
      bind(deck);
    }

    function renderSection(stale) {
      const entries = buildEntries(stale);
      if (!entries.length) return "";
      return '<div class="section">' + (stale ? "历史关闭" : "已打开") + '</div>' + entries.join("");
    }

    function buildEntries(stale) {
      const byId = new Map(windows.map((item) => [item.windowId, item]));
      const grouped = new Set(layout.groups.flatMap((group) => group.windowIds));
      const out = [];
      for (const id of layout.order) {
        const group = layout.groups.find((item) => item.windowIds[0] === id);
        if (group) {
          const items = group.windowIds.map((windowId) => byId.get(windowId)).filter(Boolean);
          if (items.length && items.every((item) => item.stale) === stale) out.push(renderGroup(group, items));
          continue;
        }
        const item = byId.get(id);
        if (item && !grouped.has(id) && item.stale === stale) out.push(renderRow(item));
      }
      return out;
    }

    function renderGroup(group, items) {
      const title = group.title || items.map((item) => item.title).join(" / ") || "分组";
      const color = group.color || (items[0] && items[0].color) || "#4f8cff";
      const sorted = [...items].sort((a, b) => Number(a.stale) - Number(b.stale));
      return '<section class="group ' + (group.collapsed ? "collapsed" : "") + '" data-group-id="' + esc(group.id) + '">' +
        '<div class="group-head" draggable="true" data-group-id="' + esc(group.id) + '">' +
        '<button class="icon" data-collapse="' + esc(group.id) + '">' + (group.collapsed ? "›" : "⌄") + '</button>' +
        '<span class="box" style="--item-color:' + esc(color) + '"></span>' +
        '<span class="group-title">' + esc(title) + '</span>' +
        '<button class="icon" data-ungroup="' + esc(group.id) + '">×</button>' +
        '</div><div class="group-body">' + sorted.map(renderRow).join("") + '</div></section>';
    }

    function renderRow(item) {
      const classes = ["row", item.windowId === currentWindowId ? "current" : "", item.stale ? "stale" : ""].filter(Boolean).join(" ");
      return '<div draggable="true" class="' + classes + '" data-window-id="' + esc(item.windowId) + '" style="--item-color:' + esc(item.color) + '">' +
        '<span class="box"></span><span class="title">' + esc(item.title) + '<span class="meta">' + esc(item.meta) + '</span></span>' +
        '<span>' + (item.stale ? '<button class="icon" data-remove="' + esc(item.windowId) + '">×</button>' : "") + '</span></div>';
    }

    function bind(scope) {
      scope.querySelectorAll(".row").forEach((row) => {
        row.addEventListener("click", (event) => {
          if (event.target.closest("button")) return;
          const item = findWindow(row.dataset.windowId);
          vscode.postMessage({ type: item && item.stale ? "open" : "focus", windowId: row.dataset.windowId });
        });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showWindowMenu(row.dataset.windowId, event.clientX, event.clientY);
        });
        row.addEventListener("dragstart", (event) => {
          dragState = { type: "window", windowId: row.dataset.windowId };
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", row.dataset.windowId);
        });
        row.addEventListener("dragover", (event) => {
          if (!dragState || dragState.windowId === row.dataset.windowId) return;
          event.preventDefault();
          const merge = event.offsetX > row.clientWidth * 0.35 && event.offsetX < row.clientWidth * 0.75;
          row.classList.toggle("drop-merge", merge);
          row.classList.toggle("drop-before", !merge);
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-merge", "drop-before"));
        row.addEventListener("drop", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const merge = event.offsetX > row.clientWidth * 0.35 && event.offsetX < row.clientWidth * 0.75;
          if (dragState.type === "group") moveGroupBeforeWindow(dragState.groupId, row.dataset.windowId);
          else if (merge) mergeWindows(dragState.windowId, row.dataset.windowId);
          else moveBefore(dragState.windowId, row.dataset.windowId);
          dragState = null;
          saveLayout();
        });
      });
      scope.querySelectorAll(".group").forEach((group) => {
        group.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showGroupMenu(group.dataset.groupId, event.clientX, event.clientY);
        });
        group.addEventListener("dragover", (event) => {
          if (!dragState) return;
          event.preventDefault();
          group.classList.add("drop-into");
        });
        group.addEventListener("dragleave", () => group.classList.remove("drop-into"));
        group.addEventListener("drop", (event) => {
          if (!dragState) return;
          event.preventDefault();
          event.stopPropagation();
          group.classList.remove("drop-into");
          if (dragState.type === "window") addWindowToGroup(dragState.windowId, group.dataset.groupId);
          else moveGroupBefore(dragState.groupId, group.dataset.groupId);
          dragState = null;
          saveLayout();
        });
      });
      scope.querySelectorAll(".group-head").forEach((head) => {
        head.addEventListener("dragstart", (event) => {
          dragState = { type: "group", groupId: head.dataset.groupId };
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", firstWindowInGroup(head.dataset.groupId));
        });
      });
      scope.querySelectorAll("[data-collapse]").forEach((button) => button.addEventListener("click", (event) => {
        event.stopPropagation();
        const group = layout.groups.find((item) => item.id === button.dataset.collapse);
        if (group) group.collapsed = !group.collapsed;
        saveLayout();
      }));
      scope.querySelectorAll("[data-ungroup]").forEach((button) => button.addEventListener("click", (event) => {
        event.stopPropagation();
        ungroup(button.dataset.ungroup);
        saveLayout();
      }));
      scope.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", (event) => {
        event.stopPropagation();
        removeFromLayout(button.dataset.remove);
        vscode.postMessage({ type: "remove", windowId: button.dataset.remove });
      }));
    }

    function showWindowMenu(windowId, x, y) {
      const item = findWindow(windowId);
      menu.innerHTML = '<button data-cmd="rename">重命名标题</button><button data-cmd="remove">删除记录</button><div class="palette">' +
        COLORS.map((color) => '<button class="swatch" title="' + esc(color) + '" data-color="' + esc(color) + '" style="--swatch:' + esc(color) + '"></button>').join("") +
        '</div>';
      placeMenu(x, y);
      menu.querySelector('[data-cmd="rename"]').onclick = () => {
        menu.classList.remove("open");
        const alias = prompt("窗口标题", item ? item.title : "");
        if (alias !== null) vscode.postMessage({ type: "rename", windowId, alias: alias.trim() });
      };
      menu.querySelector('[data-cmd="remove"]').onclick = () => {
        menu.classList.remove("open");
        removeFromLayout(windowId);
        vscode.postMessage({ type: "remove", windowId });
      };
      menu.querySelectorAll("[data-color]").forEach((button) => button.onclick = () => {
        menu.classList.remove("open");
        vscode.postMessage({ type: "color", windowId, color: button.dataset.color });
      });
    }

    function showGroupMenu(groupId, x, y) {
      const group = layout.groups.find((item) => item.id === groupId);
      menu.innerHTML = '<button data-cmd="rename">重命名分组</button><button data-cmd="collapse">展开/合上</button><button data-cmd="ungroup">取消分组</button>';
      placeMenu(x, y);
      menu.querySelector('[data-cmd="rename"]').onclick = () => {
        menu.classList.remove("open");
        const title = prompt("分组标题", group ? group.title : "分组");
        if (title !== null && group) {
          group.title = title.trim() || "分组";
          saveLayout();
        }
      };
      menu.querySelector('[data-cmd="collapse"]').onclick = () => {
        menu.classList.remove("open");
        if (group) group.collapsed = !group.collapsed;
        saveLayout();
      };
      menu.querySelector('[data-cmd="ungroup"]').onclick = () => {
        menu.classList.remove("open");
        ungroup(groupId);
        saveLayout();
      };
    }

    function placeMenu(x, y) {
      menu.style.left = Math.min(x, window.innerWidth - 205) + "px";
      menu.style.top = Math.min(y, window.innerHeight - 170) + "px";
      menu.classList.add("open");
    }

    function normalizeLayout(next) {
      const ids = windows.map((item) => item.windowId);
      const known = new Set(ids);
      const seen = new Set();
      const order = (next.order || []).filter((id) => known.has(id) && !seen.has(id) && seen.add(id));
      ids.forEach((id) => { if (!seen.has(id)) order.push(id); });
      const groups = (next.groups || []).map((group) => ({
        id: group.id,
        title: group.title || "分组",
        color: group.color,
        collapsed: Boolean(group.collapsed),
        windowIds: dedupe(group.windowIds || []).filter((id) => known.has(id))
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
      if (existing) existing.windowIds = dedupe([...existing.windowIds, sourceId]);
      else {
        const source = findWindow(sourceId);
        const target = findWindow(targetId);
        layout.groups.push({
          id: "group-" + Date.now().toString(36),
          title: [target && target.title, source && source.title].filter(Boolean).join(" / ") || "分组",
          color: target && target.color,
          collapsed: false,
          windowIds: [targetId, sourceId]
        });
      }
      layout.order = layout.order.filter((id) => id !== sourceId);
      if (!layout.order.includes(targetId)) layout.order.push(targetId);
    }
    function addWindowToGroup(windowId, groupId) {
      const group = layout.groups.find((item) => item.id === groupId);
      if (!windowId || !group || group.windowIds.includes(windowId)) return;
      removeFromGroups(windowId);
      group.windowIds.push(windowId);
      group.collapsed = false;
      layout.order = layout.order.filter((id) => id !== windowId);
    }
    function moveGroupBefore(sourceGroupId, targetGroupId) {
      if (!sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId) return;
      const sourceFirst = firstWindowInGroup(sourceGroupId);
      const targetFirst = firstWindowInGroup(targetGroupId);
      if (!sourceFirst || !targetFirst) return;
      layout.order = layout.order.filter((id) => id !== sourceFirst);
      const index = Math.max(0, layout.order.indexOf(targetFirst));
      layout.order.splice(index, 0, sourceFirst);
    }
    function moveGroupBeforeWindow(sourceGroupId, targetWindowId) {
      if (!sourceGroupId || !targetWindowId) return;
      const sourceFirst = firstWindowInGroup(sourceGroupId);
      if (!sourceFirst || sourceFirst === targetWindowId) return;
      layout.order = layout.order.filter((id) => id !== sourceFirst);
      const index = Math.max(0, layout.order.indexOf(targetWindowId));
      layout.order.splice(index, 0, sourceFirst);
    }
    function removeFromGroups(windowId) {
      layout.groups = layout.groups.map((group) => ({ ...group, windowIds: group.windowIds.filter((id) => id !== windowId) })).filter((group) => group.windowIds.length > 0);
    }
    function removeFromLayout(windowId) {
      layout.order = layout.order.filter((id) => id !== windowId);
      removeFromGroups(windowId);
      saveLayout();
    }
    function ungroup(groupId) {
      const group = layout.groups.find((item) => item.id === groupId);
      layout.groups = layout.groups.filter((item) => item.id !== groupId);
      if (!group) return;
      const at = Math.max(0, layout.order.indexOf(group.windowIds[0]));
      layout.order = layout.order.filter((id) => !group.windowIds.includes(id));
      layout.order.splice(at, 0, ...group.windowIds);
    }
    function firstWindowInGroup(groupId) {
      const group = layout.groups.find((item) => item.id === groupId);
      return group && group.windowIds[0] || "";
    }
    function saveLayout() {
      layout = normalizeLayout(layout);
      vscode.postMessage({ type: "layout", layout });
      render();
    }
    function findWindow(windowId) { return windows.find((item) => item.windowId === windowId); }
    function dedupe(values) {
      const seen = new Set();
      return values.filter((value) => !seen.has(value) && seen.add(value));
    }
    function esc(value) {
      return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
  </script>
</body>
</html>`;
}

function toViewModel(record: WindowRecord): Record<string, string | boolean> {
  const title = titleFromRecord(record.alias, record.workspaceName);
  const meta = [remoteLabel(record), compactPath(record.workspaceUri), record.git?.branch, record.state.stale ? "历史" : relativeAge(record.state.lastSeenAt)]
    .filter(Boolean)
    .join(" · ");
  return {
    windowId: record.windowId,
    title,
    color: record.color ?? "#4f8cff",
    meta,
    stale: record.state.stale,
    active: record.state.active,
    workspaceKind: record.workspaceKind,
    workspaceUri: record.workspaceUri ?? "",
    remoteKind: record.remote.kind,
    branch: record.git?.branch ?? ""
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
