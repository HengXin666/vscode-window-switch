import * as vscode from "vscode";

import { Registry } from "./registry";
import { WindowDeckLayout, WindowRecord, WindowTerminalRecord } from "./types";
import { applyStaleState } from "./windowMetadata";
import { compactPath, relativeAge, titleFromRecord } from "./util";
import { normalizeVisibleLayout, orderVisibleRecords, visibleWindowRecords } from "./windowView";

type PanelActions = {
  checkForUpdates(): Promise<void>;
  focusWindow(windowId: string): Promise<void>;
  focusTerminal(windowId: string, terminalId: string): Promise<void>;
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
  terminalId?: string;
  alias?: string;
  color?: string;
  layout?: WindowDeckLayout;
};

type WindowDeckItemViewModel = {
  windowId: string;
  title: string;
  color: string;
  meta: string;
  stale: boolean;
  active: boolean;
  workspaceKind: WindowRecord["workspaceKind"];
  workspaceUri: string;
  remoteKind: WindowRecord["remote"]["kind"];
  branch: string;
  terminals: WindowTerminalRecord[];
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
    const displayLayout = {
      ...layout,
      order: ordered.map((record) => record.windowId)
    };
    await this.panel.webview.postMessage({
      type: "windows",
      windows: ordered.map(toViewModel),
      layout: displayLayout,
      currentWindowId: this.currentWindowId()
    });
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    if (message.type === "layout" && message.layout) {
      await this.actions.saveLayout(message.layout);
    } else if (message.type === "checkForUpdates") {
      await this.actions.checkForUpdates();
    } else if (message.windowId && message.type === "focus") {
      await this.actions.focusWindow(message.windowId);
    } else if (message.windowId && message.type === "open") {
      await this.actions.openWindow(message.windowId);
    } else if (message.windowId && message.terminalId && message.type === "terminal") {
      await this.actions.focusTerminal(message.windowId, message.terminalId);
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
    :root { color-scheme: light dark; --radius: 6px; --indent: 28px; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .surface { width: min(760px, calc(100vw - 24px)); margin: 12px auto; border: 1px solid var(--vscode-widget-border); border-radius: var(--radius); background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); box-shadow: 0 8px 28px rgba(0,0,0,.28); overflow: hidden; }
    .surface.merged-mode { width: min(1180px, calc(100vw - 24px)); }
    .head { display: flex; align-items: center; min-height: 34px; padding: 0 10px; border-bottom: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); font-weight: 600; }
    .head small { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; }
    .head button { margin-left: 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 3px 7px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; font-size: 11px; }
    .list { max-height: calc(100vh - 90px); overflow: auto; padding: 6px; }
    .section { padding: 8px 6px 4px; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; }
    .row, .group-head { display: grid; grid-template-columns: 18px 12px minmax(0,1fr) auto; gap: 7px; align-items: center; min-height: 32px; padding: 4px 7px; margin: 2px 0; border: 1px solid transparent; border-radius: 5px; background: transparent; cursor: pointer; user-select: none; transition: transform .14s ease, background-color .12s ease, opacity .12s ease, box-shadow .12s ease, outline-color .12s ease; }
    .row { grid-template-columns: 18px 12px minmax(0,1fr) minmax(0,auto) auto; }
    .row.child { margin-left: var(--indent); }
    .row:hover, .group-head:hover { background: var(--vscode-list-hoverBackground); }
    .row.current { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .row.stale { opacity: .62; }
    .dragging { opacity: .42; transform: scale(.985); }
    .drop-before { box-shadow: 0 -2px 0 var(--vscode-focusBorder); transform: translateY(2px); }
    .drop-merge, .drop-into { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; background: var(--vscode-list-hoverBackground); }
    .merge-hint { color: var(--vscode-focusBorder); font-size: 11px; font-weight: 600; margin-left: 8px; }
    .box { width: 12px; height: 12px; border-radius: 2px; border: 1px solid color-mix(in srgb, var(--item-color), #000 18%); background: var(--item-color); box-sizing: border-box; }
    .title, .group-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .title { display: flex; align-items: center; gap: 6px; }
    .meta { min-width: 0; max-width: min(220px, 32%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; }
    .terminals { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; min-width: 0; max-width: 300px; }
    .terminal { --terminal-color: var(--vscode-descriptionForeground); display: inline-flex; align-items: center; gap: 4px; max-width: 150px; height: 18px; padding: 0 5px; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--terminal-color), transparent 58%); border-radius: 4px; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--terminal-color), transparent 88%); font: inherit; font-size: 10px; line-height: 18px; cursor: default; }
    .terminal.running { --terminal-color: #3794ff; }
    .terminal.waitingInput { --terminal-color: #d29922; }
    .terminal.idle { --terminal-color: var(--vscode-descriptionForeground); opacity: .78; }
    .terminal svg { flex: 0 0 12px; width: 12px; height: 12px; color: var(--terminal-color); }
    .terminal-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon { width: 22px; height: 22px; border: 0; border-radius: 4px; color: inherit; background: transparent; cursor: pointer; line-height: 20px; }
    .icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    .group { margin: 2px 0 4px; }
    .group-body { margin-left: 9px; padding-left: 18px; border-left: 1px solid var(--vscode-widget-border); }
    .group.collapsed .group-body { display: none; }
    .rename-input { width: 100%; min-height: 24px; box-sizing: border-box; border: 1px solid var(--vscode-focusBorder); border-radius: 4px; padding: 2px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
    .menu { position: fixed; z-index: 10; display: none; min-width: 188px; padding: 5px; border: 1px solid var(--vscode-widget-border); border-radius: var(--radius); background: var(--vscode-dropdown-background); box-shadow: 0 8px 24px rgba(0,0,0,.32); }
    .menu.open { display: block; }
    .menu button { display: block; width: 100%; min-height: 27px; padding: 4px 8px; border: 0; border-radius: 4px; color: var(--vscode-dropdown-foreground); background: transparent; text-align: left; cursor: pointer; }
    .menu button:hover { background: var(--vscode-list-hoverBackground); }
    .palette { display: grid; grid-template-columns: repeat(8, 18px); gap: 5px; padding: 6px 4px 3px; }
    .swatch { width: 18px !important; min-height: 18px !important; padding: 0 !important; border: 1px solid var(--vscode-contrastBorder) !important; border-radius: 3px !important; background: var(--swatch) !important; }
    .empty { padding: 14px; color: var(--vscode-descriptionForeground); }
    .tabs { display: flex; align-items: end; min-height: 35px; padding: 0 8px; border-bottom: 1px solid var(--vscode-widget-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
    .tab { align-self: stretch; min-width: 100px; padding: 0 14px; border: 0; border-bottom: 2px solid transparent; color: var(--vscode-tab-inactiveForeground); background: transparent; cursor: pointer; font: inherit; }
    .tab.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-tab-activeForeground); background: var(--vscode-tab-activeBackground); }
    .mode-help { margin-left: auto; align-self: center; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .merged { display: grid; grid-template-columns: minmax(170px, 24%) minmax(280px, 1fr) minmax(190px, 27%); min-height: min(620px, calc(100vh - 96px)); }
    .merged-column { min-width: 0; border-right: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); }
    .merged-column:last-child { border-right: 0; border-left: 1px solid var(--vscode-widget-border); }
    .merged-title { padding: 9px 10px; border-bottom: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .merged-window, .merged-terminal { display: flex; align-items: center; gap: 7px; width: calc(100% - 8px); min-height: 36px; margin: 4px; padding: 5px 8px; box-sizing: border-box; border: 1px solid transparent; border-radius: 5px; color: inherit; background: transparent; cursor: pointer; text-align: left; font: inherit; }
    .merged-window:hover, .merged-terminal:hover { background: var(--vscode-list-hoverBackground); }
    .merged-window.current, .merged-terminal.current { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .merged-window.stale { opacity: .58; }
    .merged-main { display: flex; flex-direction: column; min-width: 0; background: var(--vscode-terminal-background, var(--vscode-editor-background)); }
    .native-terminal { display: grid; flex: 1; place-content: center; gap: 12px; padding: 28px; color: var(--vscode-descriptionForeground); text-align: center; }
    .native-terminal strong { color: var(--vscode-foreground); font-size: 14px; }
    .native-terminal button { justify-self: center; padding: 6px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; }
    .merged-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .merged-state { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 10px; white-space: nowrap; }
    @media (max-width: 560px) {
      .row { grid-template-columns: 18px 12px minmax(0,1fr) auto; }
      .row > .terminals { grid-column: 3 / span 2; grid-row: 2; justify-content: flex-start; max-width: none; }
      .row > span:last-child { grid-column: 4; grid-row: 1; }
    }
  </style>
</head>
<body>
  <main class="surface">
    <div class="head">Window Deck <small>窗口与原生终端导航</small><button id="check-updates" title="从 GitHub Release 检查 Window Deck 更新">检查更新</button></div>
    <nav class="tabs"><button class="tab active" data-tab="quick">快速切换</button><button class="tab" data-tab="merged">合并终端</button><span class="mode-help" id="mode-help">终端仅显示状态，不可预览或操作</span></nav>
    <div class="list" id="deck"></div>
  </main>
  <div class="menu" id="menu"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const COLORS = ["#4f8cff", "#2fb344", "#f59f00", "#e03131", "#9c36b5", "#0ca678", "#f76707", "#495057"];
    const deck = document.getElementById("deck");
    const menu = document.getElementById("menu");
    const modeHelp = document.getElementById("mode-help");
    document.getElementById("check-updates").addEventListener("click", () => vscode.postMessage({ type: "checkForUpdates" }));
    let windows = [];
    let layout = { order: [], groups: [] };
    let currentWindowId = "";
    let dragState = null;
    let editing = false;
    let activeTab = "quick";
    let selectedMergedWindowId = "";
    let selectedMergedTerminalId = "";
    document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item === tab));
      modeHelp.textContent = activeTab === "quick" ? "终端仅显示状态，不可预览或操作" : "终端交互使用 VS Code 原生终端";
      document.querySelector(".surface").classList.toggle("merged-mode", activeTab === "merged");
      render();
    }));

    window.addEventListener("message", (event) => {
      if (event.data.type !== "windows") return;
      windows = event.data.windows || [];
      layout = normalizeLayout(event.data.layout || { order: [], groups: [] });
      currentWindowId = event.data.currentWindowId || "";
      if (!editing) render();
    });
    document.addEventListener("click", (event) => { if (!event.target.closest("#menu")) closeMenu(); }, true);

    function render() {
      renderWithFlip(() => {
        layout = normalizeLayout(layout);
        deck.classList.toggle("list", activeTab === "quick");
        deck.innerHTML = activeTab === "quick" ? (renderSection(false) + renderSection(true) || '<div class="empty">没有已注册的工作区窗口。</div>') : renderMergedTerminal();
        bind(deck);
      });
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
        if (item && !grouped.has(id) && item.stale === stale) out.push(renderRow(item, false));
      }
      return out;
    }

    function renderGroup(group, items) {
      const title = group.title || items.map((item) => item.title).join(" / ") || "分组";
      const color = group.color || (items[0] && items[0].color) || "#4f8cff";
      return '<section class="group ' + (group.collapsed ? "collapsed" : "") + '" data-key="group:' + esc(group.id) + '" data-group-id="' + esc(group.id) + '">' +
        '<div class="group-head" draggable="true" data-key="group-head:' + esc(group.id) + '" data-group-id="' + esc(group.id) + '">' +
        '<button class="icon" data-collapse="' + esc(group.id) + '">' + (group.collapsed ? "›" : "⌄") + '</button>' +
        '<span class="box" style="--item-color:' + esc(color) + '"></span>' +
        '<span class="group-title" data-group-title="' + esc(group.id) + '">' + esc(title) + '</span>' +
        '<button class="icon" data-ungroup="' + esc(group.id) + '">×</button>' +
        '</div><div class="group-body">' + items.map((item) => renderRow(item, true)).join("") + '</div></section>';
    }

    function renderRow(item, child) {
      const classes = ["row", child ? "child" : "", item.windowId === currentWindowId ? "current" : "", item.stale ? "stale" : ""].filter(Boolean).join(" ");
      return '<div draggable="true" class="' + classes + '" data-key="window:' + esc(item.windowId) + '" data-window-id="' + esc(item.windowId) + '" style="--item-color:' + esc(item.color) + '">' +
        '<span></span><span class="box"></span><span class="title" data-window-title="' + esc(item.windowId) + '">' + esc(item.title) + '<span class="meta">' + esc(item.meta) + '</span></span>' +
        renderTerminals(item.terminals) +
        '<span>' + (item.stale ? '<button class="icon" data-remove="' + esc(item.windowId) + '">×</button>' : "") + '</span></div>';
    }

    function renderTerminals(terminals) {
      const items = (terminals || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!items.length) return '<span class="terminals"></span>';
      return '<span class="terminals">' + items.map((terminal, index) => {
        const state = terminal.state || "idle";
        const label = terminalLabel(terminal);
        return '<span class="terminal ' + esc(state) + '" title="' + esc((index + 1) + ". " + terminalStateLabel(state) + " " + label) + '">' +
          terminalIcon(state) + '<span class="terminal-label">' + esc(label) + '</span></span>';
      }).join("") + '</span>';
    }

    function terminalLabel(terminal) {
      return terminal.commandLine || terminal.name || terminal.shell || "terminal";
    }
    function terminalStateLabel(state) {
      if (state === "running") return "运行中";
      if (state === "waitingInput") return "等待输入";
      return "空闲";
    }
    function terminalIcon(state) {
      if (state === "running") return '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3.5v9l7-4.5-7-4.5Z"/></svg>';
      if (state === "waitingInput") return '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M3 4.5h10v7H3zM5 7h.01M8 7h.01M11 7h.01M6 9.5h4"/></svg>';
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M2.75 4.25h10.5v7.5H2.75zM5 6.5 7 8l-2 1.5M8.25 9.5h2.5"/></svg>';
    }

    function renderMergedTerminal() {
      const opened = windows.filter((item) => !item.stale);
      const selectedWindow = findWindow(selectedMergedWindowId) || findWindow(currentWindowId) || opened[0];
      selectedMergedWindowId = selectedWindow ? selectedWindow.windowId : "";
      const terminals = selectedWindow ? (selectedWindow.terminals || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)) : [];
      if (!terminals.some((item) => item.terminalId === selectedMergedTerminalId)) {
        const activeTerminal = terminals.find((item) => item.active) || terminals[0];
        selectedMergedTerminalId = activeTerminal ? activeTerminal.terminalId : "";
      }
      const selectedTerminal = terminals.find((item) => item.terminalId === selectedMergedTerminalId);
      const windowItems = windows.map((item) => '<button class="merged-window ' + (item.windowId === selectedMergedWindowId ? "current " : "") + (item.stale ? "stale" : "") + '" data-merged-window="' + esc(item.windowId) + '"><span class="box" style="--item-color:' + esc(item.color) + '"></span><span class="merged-name">' + esc(item.title) + '</span></button>').join("");
      const terminalItems = terminals.map((terminal) => '<button class="merged-terminal ' + (terminal.terminalId === selectedMergedTerminalId ? "current" : "") + '" data-merged-terminal="' + esc(terminal.terminalId) + '">' + terminalIcon(terminal.state || "idle") + '<span class="merged-name">' + esc(terminal.name || terminal.shell || "terminal") + '</span><span class="merged-state">' + esc(terminalStateLabel(terminal.state || "idle")) + '</span></button>').join("");
      const center = selectedTerminal
        ? '<div class="native-terminal"><strong>' + esc((selectedWindow ? selectedWindow.title + " · " : "") + (selectedTerminal.name || "terminal")) + '</strong><span>这里使用 VS Code 原生终端，不复制输出，也不模拟输入。</span><button data-open-native-terminal>打开并操作原生终端</button></div>'
        : '<div class="native-terminal"><strong>当前窗口没有已打开的终端</strong><span>请先在该窗口创建终端。</span></div>';
      return '<div class="merged"><aside class="merged-column"><div class="merged-title">窗口</div>' + (windowItems || '<div class="empty">没有窗口</div>') + '</aside><section class="merged-main"><div class="merged-title">原生终端</div>' + center + '</section><aside class="merged-column"><div class="merged-title">当前窗口的终端</div>' + (terminalItems || '<div class="empty">没有终端</div>') + '</aside></div>';
    }

    function bind(scope) {
      scope.querySelectorAll("[data-merged-window]").forEach((item) => item.addEventListener("click", () => {
        selectedMergedWindowId = item.dataset.mergedWindow;
        selectedMergedTerminalId = "";
        const target = findWindow(selectedMergedWindowId);
        vscode.postMessage({ type: target && target.stale ? "open" : "focus", windowId: selectedMergedWindowId });
        render();
      }));
      scope.querySelectorAll("[data-merged-terminal]").forEach((item) => item.addEventListener("click", () => {
        selectedMergedTerminalId = item.dataset.mergedTerminal;
        vscode.postMessage({ type: "terminal", windowId: selectedMergedWindowId, terminalId: selectedMergedTerminalId });
        render();
      }));
      scope.querySelector("[data-open-native-terminal]")?.addEventListener("click", () => {
        vscode.postMessage({ type: "terminal", windowId: selectedMergedWindowId, terminalId: selectedMergedTerminalId });
      });
      scope.querySelectorAll(".row").forEach((row) => {
        row.addEventListener("click", (event) => {
          if (event.target.closest("button") || event.target.closest("input")) return;
          const item = findWindow(row.dataset.windowId);
          vscode.postMessage({ type: item && item.stale ? "open" : "focus", windowId: row.dataset.windowId });
        });
        row.addEventListener("dblclick", (event) => { event.preventDefault(); beginRenameWindow(row.dataset.windowId); });
        row.addEventListener("contextmenu", (event) => { event.preventDefault(); showWindowMenu(row.dataset.windowId, event.clientX, event.clientY); });
        row.addEventListener("dragstart", (event) => {
          dragState = { type: "window", windowId: row.dataset.windowId, original: cloneLayout(layout), committed: false };
          row.classList.add("dragging");
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", row.dataset.windowId);
        });
        row.addEventListener("dragover", (event) => {
          if (!dragState || dragState.windowId === row.dataset.windowId) return;
          event.preventDefault();
          const merge = isMergeZone(event, row);
          clearDropClasses();
          if (merge && dragState.type === "window") {
            row.classList.add("drop-merge");
            showMergeHint(row, groupIdForWindow(row.dataset.windowId) ? "松开加入分组" : "松开创建分组");
            return;
          }
          row.classList.add("drop-before");
          if (dragState.type === "window") preview(() => moveBefore(dragState.windowId, row.dataset.windowId));
          else preview(() => moveGroupBeforeWindow(dragState.groupId, row.dataset.windowId));
        });
        row.addEventListener("drop", (event) => {
          if (!dragState) return;
          event.preventDefault();
          event.stopPropagation();
          const merge = isMergeZone(event, row);
          if (dragState.type === "group") moveGroupBeforeWindow(dragState.groupId, row.dataset.windowId);
          else if (merge) mergeWindows(dragState.windowId, row.dataset.windowId);
          else moveBefore(dragState.windowId, row.dataset.windowId);
          dragState.committed = true;
          saveLayout();
        });
        row.addEventListener("dragend", finishDrag);
      });
      scope.querySelectorAll(".group").forEach((group) => {
        group.addEventListener("contextmenu", (event) => { event.preventDefault(); showGroupMenu(group.dataset.groupId, event.clientX, event.clientY); });
        group.addEventListener("dragover", (event) => {
          if (!dragState || dragState.groupId === group.dataset.groupId) return;
          event.preventDefault();
          clearDropClasses();
          group.querySelector(".group-head")?.classList.add("drop-into");
          if (dragState.type === "window") showMergeHint(group.querySelector(".group-head"), "松开加入分组");
          else preview(() => moveGroupBefore(dragState.groupId, group.dataset.groupId));
        });
        group.addEventListener("drop", (event) => {
          if (!dragState) return;
          event.preventDefault();
          event.stopPropagation();
          if (dragState.type === "window") addWindowToGroup(dragState.windowId, group.dataset.groupId);
          else moveGroupBefore(dragState.groupId, group.dataset.groupId);
          dragState.committed = true;
          saveLayout();
        });
      });
      scope.querySelectorAll(".group-head").forEach((head) => {
        head.addEventListener("dblclick", (event) => { event.preventDefault(); beginRenameGroup(head.dataset.groupId); });
        head.addEventListener("dragstart", (event) => {
          dragState = { type: "group", groupId: head.dataset.groupId, original: cloneLayout(layout), committed: false };
          head.closest(".group")?.classList.add("dragging");
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", firstWindowInGroup(head.dataset.groupId));
        });
        head.addEventListener("dragend", finishDrag);
      });
      scope.querySelectorAll("[data-collapse]").forEach((button) => button.addEventListener("click", (event) => {
        event.stopPropagation();
        const group = layout.groups.find((item) => item.id === button.dataset.collapse);
        if (group) group.collapsed = !group.collapsed;
        saveLayout();
      }));
      scope.querySelectorAll("[data-ungroup]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); ungroup(button.dataset.ungroup); saveLayout(); }));
      scope.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", (event) => {
        event.stopPropagation();
        removeFromLayout(button.dataset.remove);
        vscode.postMessage({ type: "remove", windowId: button.dataset.remove });
      }));
    }

    function showWindowMenu(windowId, x, y) {
      menu.innerHTML = '<button data-cmd="rename">重命名标题</button><button data-cmd="remove">删除记录</button><div class="palette">' +
        COLORS.map((color) => '<button class="swatch" title="' + esc(color) + '" data-color="' + esc(color) + '" style="--swatch:' + esc(color) + '"></button>').join("") + '</div>';
      placeMenu(x, y);
      menu.querySelector('[data-cmd="rename"]').onclick = () => { closeMenu(); beginRenameWindow(windowId); };
      menu.querySelector('[data-cmd="remove"]').onclick = () => { closeMenu(); removeFromLayout(windowId); vscode.postMessage({ type: "remove", windowId }); };
      menu.querySelectorAll("[data-color]").forEach((button) => button.onclick = () => { closeMenu(); vscode.postMessage({ type: "color", windowId, color: button.dataset.color }); });
    }

    function showGroupMenu(groupId, x, y) {
      const group = layout.groups.find((item) => item.id === groupId);
      menu.innerHTML = '<button data-cmd="rename">重命名分组</button><button data-cmd="collapse">展开/合上</button><button data-cmd="ungroup">取消分组</button>';
      placeMenu(x, y);
      menu.querySelector('[data-cmd="rename"]').onclick = () => { closeMenu(); beginRenameGroup(groupId); };
      menu.querySelector('[data-cmd="collapse"]').onclick = () => { closeMenu(); if (group) group.collapsed = !group.collapsed; saveLayout(); };
      menu.querySelector('[data-cmd="ungroup"]').onclick = () => { closeMenu(); ungroup(groupId); saveLayout(); };
    }

    function beginRenameWindow(windowId) {
      const item = findWindow(windowId);
      const target = deck.querySelector('[data-window-title="' + cssEscape(windowId) + '"]');
      if (item && target) beginInlineRename(target, item.title, (value) => vscode.postMessage({ type: "rename", windowId, alias: value.trim() }));
    }
    function beginRenameGroup(groupId) {
      const group = layout.groups.find((item) => item.id === groupId);
      const target = deck.querySelector('[data-group-title="' + cssEscape(groupId) + '"]');
      if (group && target) beginInlineRename(target, group.title || "分组", (value) => { group.title = value.trim() || "分组"; saveLayout(); });
    }
    function beginInlineRename(target, value, commit) {
      editing = true;
      const input = document.createElement("input");
      input.className = "rename-input";
      input.value = value || "";
      target.replaceChildren(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (apply) => {
        if (done) return;
        done = true;
        editing = false;
        if (apply) commit(input.value);
        else render();
      };
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") finish(true); if (event.key === "Escape") finish(false); });
      input.addEventListener("blur", () => finish(true));
    }

    function preview(mutator) {
      const next = cloneLayout(layout);
      mutator();
      layout = normalizeLayout(layout);
      if (JSON.stringify(next) !== JSON.stringify(layout)) render();
    }
    function finishDrag() {
      if (dragState && !dragState.committed) {
        layout = dragState.original;
        render();
      }
      clearDropClasses();
      deck.querySelectorAll(".dragging").forEach((item) => item.classList.remove("dragging"));
      dragState = null;
    }
    function renderWithFlip(update) {
      const before = measureItems();
      update();
      requestAnimationFrame(() => {
        const after = measureItems();
        after.forEach((rect, key) => {
          const old = before.get(key);
          if (!old) return;
          const dx = old.left - rect.left;
          const dy = old.top - rect.top;
          if (!dx && !dy) return;
          const element = deck.querySelector('[data-key="' + cssEscape(key) + '"]');
          if (!element) return;
          element.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "translate(0,0)" }], { duration: 150, easing: "ease-out" });
        });
      });
    }
    function measureItems() {
      const map = new Map();
      deck.querySelectorAll("[data-key]").forEach((element) => map.set(element.dataset.key, element.getBoundingClientRect()));
      return map;
    }
    function showMergeHint(target, text) {
      if (!target || target.querySelector(".merge-hint")) return;
      const hint = document.createElement("span");
      hint.className = "merge-hint";
      hint.textContent = text;
      target.querySelector(".title,.group-title")?.appendChild(hint);
    }
    function clearDropClasses() {
      deck.querySelectorAll(".drop-before,.drop-merge,.drop-into").forEach((item) => item.classList.remove("drop-before", "drop-merge", "drop-into"));
      deck.querySelectorAll(".merge-hint").forEach((item) => item.remove());
    }
    function placeMenu(x, y) { menu.style.left = Math.min(x, window.innerWidth - 205) + "px"; menu.style.top = Math.min(y, window.innerHeight - 170) + "px"; menu.classList.add("open"); }
    function closeMenu() { menu.classList.remove("open"); }
    function isMergeZone(event, row) { return event.offsetX > row.clientWidth * 0.36 && event.offsetX < row.clientWidth * 0.84; }
    function cloneLayout(value) { return JSON.parse(JSON.stringify(value)); }

    function normalizeLayout(next) {
      const ids = windows.map((item) => item.windowId);
      const known = new Set(ids);
      const seen = new Set();
      const order = (next.order || []).filter((id) => known.has(id) && !seen.has(id) && seen.add(id));
      ids.forEach((id) => { if (!seen.has(id)) order.push(id); });
      const groups = (next.groups || []).map((group) => ({ id: group.id, title: group.title || "分组", color: group.color, collapsed: Boolean(group.collapsed), windowIds: dedupe(group.windowIds || []).filter((id) => known.has(id)) })).filter((group) => group.windowIds.length > 0);
      return { order, groups };
    }
    function moveBefore(sourceId, targetId) {
      if (!sourceId || !targetId || sourceId === targetId) return;
      removeFromGroups(sourceId);
      layout.order = layout.order.filter((id) => id !== sourceId);
      layout.order.splice(Math.max(0, layout.order.indexOf(targetId)), 0, sourceId);
    }
    function mergeWindows(sourceId, targetId) {
      if (!sourceId || !targetId || sourceId === targetId) return;
      const existing = layout.groups.find((group) => group.windowIds.includes(targetId));
      removeFromGroups(sourceId);
      if (existing) existing.windowIds = dedupe([...existing.windowIds, sourceId]);
      else {
        const source = findWindow(sourceId);
        const target = findWindow(targetId);
        layout.groups.push({ id: "group-" + Date.now().toString(36), title: [target && target.title, source && source.title].filter(Boolean).join(" / ") || "分组", color: target && target.color, collapsed: false, windowIds: [targetId, sourceId] });
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
      layout.order.splice(Math.max(0, layout.order.indexOf(targetFirst)), 0, sourceFirst);
    }
    function moveGroupBeforeWindow(sourceGroupId, targetWindowId) {
      if (!sourceGroupId || !targetWindowId) return;
      const sourceFirst = firstWindowInGroup(sourceGroupId);
      if (!sourceFirst || sourceFirst === targetWindowId) return;
      layout.order = layout.order.filter((id) => id !== sourceFirst);
      layout.order.splice(Math.max(0, layout.order.indexOf(targetWindowId)), 0, sourceFirst);
    }
    function removeFromGroups(windowId) { layout.groups = layout.groups.map((group) => ({ ...group, windowIds: group.windowIds.filter((id) => id !== windowId) })).filter((group) => group.windowIds.length > 0); }
    function removeFromLayout(windowId) { layout.order = layout.order.filter((id) => id !== windowId); removeFromGroups(windowId); saveLayout(); }
    function ungroup(groupId) {
      const group = layout.groups.find((item) => item.id === groupId);
      layout.groups = layout.groups.filter((item) => item.id !== groupId);
      if (!group) return;
      const at = Math.max(0, layout.order.indexOf(group.windowIds[0]));
      layout.order = layout.order.filter((id) => !group.windowIds.includes(id));
      layout.order.splice(at, 0, ...group.windowIds);
    }
    function firstWindowInGroup(groupId) { const group = layout.groups.find((item) => item.id === groupId); return group && group.windowIds[0] || ""; }
    function groupIdForWindow(windowId) { const group = layout.groups.find((item) => item.windowIds.includes(windowId)); return group && group.id; }
    function saveLayout() { layout = normalizeLayout(layout); vscode.postMessage({ type: "layout", layout }); render(); }
    function findWindow(windowId) { return windows.find((item) => item.windowId === windowId); }
    function dedupe(values) { const seen = new Set(); return values.filter((value) => !seen.has(value) && seen.add(value)); }
    function cssEscape(value) { return window.CSS && CSS.escape ? CSS.escape(value) : String(value || "").replace(/["\\\\]/g, "\\\\$&"); }
    function esc(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  </script>
</body>
</html>`;
}

function toViewModel(record: WindowRecord): WindowDeckItemViewModel {
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
    branch: record.git?.branch ?? "",
    terminals: record.terminals ?? []
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
