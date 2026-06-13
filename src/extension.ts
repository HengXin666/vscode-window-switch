import * as vscode from "vscode";

import { focusSupportMessage, focusWindow } from "./focusAdapter";
import { Registry } from "./registry";
import { WindowRecord } from "./types";
import { applyStaleState, buildWindowRecord } from "./windowMetadata";
import { compactPath, getConfigBoolean, getConfigNumber, getConfigString, randomId, registryDirectory, relativeAge, titleFromRecord } from "./util";

let heartbeatTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let registry: Registry;
let currentWindowId: string;
let currentTitleToken: string;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registry = new Registry(registryDirectory(context));
  currentWindowId = `${process.pid}-${randomId(8)}`;
  currentTitleToken = context.workspaceState.get<string>("windowDeck.titleToken") ?? `WD:${randomId(3)}`;
  await context.workspaceState.update("windowDeck.titleToken", currentTitleToken);

  await ensureTitleToken();
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "windowDeck.showWindows";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("windowDeck.showWindows", showWindows),
    vscode.commands.registerCommand("windowDeck.renameCurrentWindow", renameCurrentWindow),
    vscode.commands.registerCommand("windowDeck.setCurrentWindowColor", setCurrentWindowColor),
    vscode.commands.registerCommand("windowDeck.configureCurrentWindow", configureCurrentWindow),
    vscode.commands.registerCommand("windowDeck.applyCurrentWindowTitle", applyCurrentWindowTitle),
    vscode.commands.registerCommand("windowDeck.cleanupStaleWindows", cleanupStaleWindows),
    vscode.commands.registerCommand("windowDeck.diagnoseFocusSupport", diagnoseFocusSupport),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("windowDeck.titleTokenMode")) {
        await ensureTitleToken();
      }
    })
  );

  await heartbeat();
  const interval = Math.max(1000, getConfigNumber("heartbeatIntervalMs") || 5000);
  heartbeatTimer = setInterval(() => {
    void heartbeat();
  }, interval);
}

export async function deactivate(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  if (registry && currentWindowId) {
    const data = await registry.read();
    const current = data.windows.find((record) => record.windowId === currentWindowId);
    if (current) {
      await registry.upsertWindow({
        ...current,
        state: {
          ...current.state,
          active: false,
          stale: true,
          lastSeenAt: Date.now()
        }
      });
    }
  }
}

async function heartbeat(): Promise<void> {
  const staleAfterMs = getConfigNumber("staleAfterMs") || 20000;
  const data = await registry.read();
  const previous = data.windows.find((record) => record.windowId === currentWindowId);
  const record = buildWindowRecord(currentWindowId, currentTitleToken, staleAfterMs, previous);
  await registry.upsertWindow(record);
  await refreshStatus(record);
}

async function showWindows(): Promise<void> {
  await heartbeat();
  const staleAfterMs = getConfigNumber("staleAfterMs") || 20000;
  const data = await registry.read();
  const windows = applyStaleState(data.windows, staleAfterMs, currentWindowId).sort(compareWindows);
  const items = windows.map((record) => toQuickPickItem(record));
  const selected = await vscode.window.showQuickPick(items, {
    title: "Window Deck",
    placeHolder: "Select a VS Code window to focus"
  });
  if (!selected) {
    return;
  }
  if (selected.record.windowId === currentWindowId) {
    await configureCurrentWindow();
    return;
  }
  const result = await focusWindow(selected.record);
  if (!result.ok) {
    await vscode.window.showWarningMessage(result.reason, "Diagnose Focus Support");
    return;
  }
  await markFocused(selected.record.windowId);
}

async function renameCurrentWindow(): Promise<void> {
  const data = await registry.read();
  const current = data.windows.find((record) => record.windowId === currentWindowId);
  const alias = await vscode.window.showInputBox({
    title: "Window Deck: Rename Current Window",
    prompt: "Alias is stored in Window Deck global storage, not in the workspace.",
    value: current?.alias ?? current?.workspaceName ?? ""
  });
  if (alias === undefined) {
    return;
  }
  await registry.saveUserConfig({ windowId: currentWindowId, alias: alias.trim() || undefined });
  await heartbeat();
}

async function setCurrentWindowColor(): Promise<void> {
  const palette = ["#4f8cff", "#2fb344", "#f59f00", "#e03131", "#9c36b5", "#0ca678", "#f76707", "#495057"];
  const picked = await vscode.window.showQuickPick(
    palette.map((color) => ({ label: color, description: "Window Deck UI color", detail: colorName(color) })),
    { title: "Window Deck: Set Current Window Color" }
  );
  if (!picked) {
    return;
  }
  await registry.saveUserConfig({ windowId: currentWindowId, color: picked.label });
  if (getConfigBoolean("applyWorkbenchColors")) {
    await applyWorkbenchColor(picked.label);
  }
  await heartbeat();
}

async function configureCurrentWindow(): Promise<void> {
  await heartbeat();
  const data = await registry.read();
  const current = data.windows.find((record) => record.windowId === currentWindowId);
  const picked = await vscode.window.showQuickPick(
    [
      { label: "$(edit) Rename", description: titleFromRecord(current?.alias, current?.workspaceName), action: "rename" },
      { label: "$(symbol-color) Set Color", description: current?.color ?? "No color", action: "color" },
      { label: "$(window) Apply VS Code Title Marker", description: `[${currentTitleToken}]`, action: "title" },
      { label: "$(symbol-color) Apply Color to Workbench", description: "Writes workspace workbench.colorCustomizations", action: "workbenchColor" },
      { label: "$(copy) Copy Window Info", description: current?.workspaceName ?? "Current window", action: "copy" }
    ],
    { title: "Window Deck: Configure Current Window" }
  );
  if (!picked) {
    return;
  }
  if (picked.action === "rename") {
    await renameCurrentWindow();
  } else if (picked.action === "color") {
    await setCurrentWindowColor();
  } else if (picked.action === "title") {
    await applyCurrentWindowTitle();
  } else if (picked.action === "workbenchColor") {
    if (!current?.color) {
      await vscode.window.showWarningMessage("Set a Window Deck color first.");
      return;
    }
    await applyWorkbenchColor(current.color);
    await vscode.window.showInformationMessage("Window Deck wrote workbench color customizations for this workspace.");
  } else if (picked.action === "copy") {
    await vscode.env.clipboard.writeText(JSON.stringify(current, null, 2));
    await vscode.window.showInformationMessage("Window Deck copied current window info.");
  }
}

async function applyCurrentWindowTitle(): Promise<void> {
  const hasWorkspace = Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
  if (!hasWorkspace) {
    await vscode.window.showWarningMessage("Window Deck can only apply a per-workspace title marker when a folder or workspace is open.");
    return;
  }
  const data = await registry.read();
  const current = data.windows.find((record) => record.windowId === currentWindowId);
  const aliasOrRoot = current?.alias?.trim() || "${rootName}";
  const title = `${aliasOrRoot}${"${separator}${activeEditorShort}"} [${currentTitleToken}]`;
  await vscode.workspace.getConfiguration("window").update("title", title, vscode.ConfigurationTarget.Workspace);
  await heartbeat();
  await vscode.window.showInformationMessage(`Window Deck applied workspace title marker [${currentTitleToken}].`);
}

async function cleanupStaleWindows(): Promise<void> {
  const removed = await registry.cleanup(getConfigNumber("removeStaleAfterMs") || 86400000);
  await vscode.window.showInformationMessage(`Window Deck cleaned ${removed} stale window${removed === 1 ? "" : "s"}.`);
}

async function diagnoseFocusSupport(): Promise<void> {
  const data = await registry.read();
  const current = data.windows.find((record) => record.windowId === currentWindowId);
  const details = [
    focusSupportMessage(),
    `Platform: ${process.platform}`,
    `Session: ${current?.platform.linuxSession ?? "n/a"}`,
    `Desktop: ${current?.platform.desktop ?? "n/a"}`,
    `Title token: ${currentTitleToken}`
  ].join("\n");
  await vscode.window.showInformationMessage(details, { modal: true });
}

async function ensureTitleToken(): Promise<void> {
  if (getConfigString("titleTokenMode") !== "visible") {
    return;
  }
  await vscode.window.showWarningMessage(
    "Window Deck cannot safely inject a unique title token through VS Code global window.title. Automatic title-token injection is disabled for this MVP."
  );
}

async function refreshStatus(record: WindowRecord): Promise<void> {
  if (!statusBarItem) {
    return;
  }
  const title = titleFromRecord(record.alias, record.workspaceName);
  statusBarItem.text = `$(window) ${title}`;
  statusBarItem.tooltip = [
    "Window Deck",
    `Current: ${title}`,
    `Workspace: ${compactPath(record.workspaceUri)}`,
    `Remote: ${remoteLabel(record)}`,
    "Click to switch window"
  ].join("\n");
  statusBarItem.show();
}

async function markFocused(windowId: string): Promise<void> {
  await registry.update((data) => {
    data.windows = data.windows.map((record) => ({
      ...record,
      state: {
        ...record.state,
        focused: record.windowId === windowId,
        lastFocusedAt: record.windowId === windowId ? Date.now() : record.state.lastFocusedAt
      }
    }));
  });
}

async function applyWorkbenchColor(color: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("workbench");
  const current = config.get<Record<string, string>>("colorCustomizations") ?? {};
  await config.update(
    "colorCustomizations",
    {
      ...current,
      "titleBar.activeBackground": color,
      "statusBar.background": color
    },
    vscode.ConfigurationTarget.Workspace
  );
}

type WindowQuickPickItem = vscode.QuickPickItem & { record: WindowRecord };

function toQuickPickItem(record: WindowRecord): WindowQuickPickItem {
  const title = titleFromRecord(record.alias, record.workspaceName);
  const dot = record.state.stale ? "○" : "●";
  const current = record.windowId === currentWindowId ? "current" : undefined;
  const stale = record.state.stale ? "stale" : undefined;
  const branch = record.git?.branch;
  const detailParts = [remoteLabel(record), compactPath(record.workspaceUri), branch, current, stale, `active ${relativeAge(record.state.lastSeenAt)}`].filter(Boolean);
  return {
    label: `${dot} ${title}`,
    description: [record.color, record.windowId === currentWindowId ? "select to configure" : undefined].filter(Boolean).join(" · "),
    detail: detailParts.join(" · "),
    record
  };
}

function colorName(color: string): string {
  const names: Record<string, string> = {
    "#4f8cff": "Blue",
    "#2fb344": "Green",
    "#f59f00": "Amber",
    "#e03131": "Red",
    "#9c36b5": "Purple",
    "#0ca678": "Teal",
    "#f76707": "Orange",
    "#495057": "Gray"
  };
  return names[color] ?? "Custom";
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

function compareWindows(a: WindowRecord, b: WindowRecord): number {
  if (a.windowId === currentWindowId) {
    return -1;
  }
  if (b.windowId === currentWindowId) {
    return 1;
  }
  if (a.state.stale !== b.state.stale) {
    return a.state.stale ? 1 : -1;
  }
  return (b.state.lastFocusedAt ?? b.state.lastSeenAt) - (a.state.lastFocusedAt ?? a.state.lastSeenAt);
}
