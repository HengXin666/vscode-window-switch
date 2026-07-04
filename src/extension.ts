import * as vscode from "vscode";

import { BridgeServer } from "./bridgeServer";
import { focusSupportMessage, focusWindow } from "./focusAdapter";
import { Registry } from "./registry";
import { WindowRecord, WindowTerminalRecord } from "./types";
import { TerminalStatusTracker } from "./terminalStatus";
import { applyStaleState, buildWindowRecord } from "./windowMetadata";
import { compactPath, desktopEnvironment, getConfigBoolean, getConfigNumber, getConfigString, linuxSession, randomId, registryDirectory, relativeAge, titleFromRecord } from "./util";
import { normalizeVisibleLayout, orderVisibleRecords, visibleWindowRecords } from "./windowView";
import { WindowDeckPanel } from "./windowDeckPanel";

let heartbeatTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let registry: Registry;
let currentWindowId: string;
let currentTitleToken: string;
let deckPanel: WindowDeckPanel | undefined;
let bridgeServer: BridgeServer | undefined;
let terminalStatusTracker: TerminalStatusTracker | undefined;
let extensionPath: string;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionPath = context.extensionPath;
  registry = new Registry(registryDirectory(context));
  currentWindowId = `${process.pid}-${randomId(8)}`;
  currentTitleToken = `WD:${randomId(5)}`;

  await ensureTitleToken();
  terminalStatusTracker = new TerminalStatusTracker();
  context.subscriptions.push(terminalStatusTracker);
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "windowDeck.showWindows";
  context.subscriptions.push(statusBarItem);
  deckPanel = new WindowDeckPanel(registry, () => currentWindowId, () => getConfigNumber("staleAfterMs") || 20000, {
    focusWindow: focusRegisteredWindow,
    openWindow,
    renameWindow,
    setWindowColor,
    removeWindow,
    saveLayout: (layout) => registry.saveLayout(layout),
    refreshCurrentWindow: heartbeat
  });
  bridgeServer = new BridgeServer(registry, () => currentWindowId, () => getConfigNumber("staleAfterMs") || 20000, {
    focusWindow: focusRegisteredWindow,
    openWindow,
    renameWindow,
    setWindowColor,
    removeWindow,
    saveLayout: (layout) => registry.saveLayout(layout),
    refreshCurrentWindow: heartbeat
  });
  await bridgeServer.start(context);
  context.subscriptions.push(bridgeServer);

  context.subscriptions.push(
    vscode.commands.registerCommand("windowDeck.installWorkbenchPatch", installWorkbenchPatch),
    vscode.commands.registerCommand("windowDeck.uninstallWorkbenchPatch", uninstallWorkbenchPatch),
    vscode.commands.registerCommand("windowDeck.openPanel", openPanel),
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
  void promptReloadAfterInstall(context);
  const interval = Math.max(1000, getConfigNumber("heartbeatIntervalMs") || 5000);
  heartbeatTimer = setInterval(() => {
    void heartbeat();
  }, interval);
}

async function promptReloadAfterInstall(context: vscode.ExtensionContext): Promise<void> {
  const version = extensionVersion(context);
  const promptKey = "windowDeck.reloadPromptVersion";
  if (context.globalState.get<string>(promptKey) === version) {
    return;
  }
  await context.globalState.update(promptKey, version);
  const picked = await vscode.window.showInformationMessage(
    "Window Deck 已安装或更新。重新加载当前窗口可立即启用最新的窗口切换和标题标记。",
    "重新加载当前窗口",
    "稍后"
  );
  if (picked === "重新加载当前窗口") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const packageJson = context.extension.packageJSON as { version?: unknown };
  return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}

async function installWorkbenchPatch(): Promise<void> {
  await vscode.window.showInformationMessage(
    "Window Deck 已改为外部悬浮窗口，不再需要安装顶部栏补丁。旧补丁可用卸载命令移除。",
    "复制卸载命令"
  ).then(async (picked) => {
    if (picked === "复制卸载命令") {
      await vscode.env.clipboard.writeText(`sudo bash ${shellQuote(`${extensionPath}/scripts/uninstall-workbench-patch.sh`)}`);
    }
  });
}

async function uninstallWorkbenchPatch(): Promise<void> {
  await vscode.window.showInformationMessage(
    "卸载 Window Deck 顶部栏补丁需要修改 VS Code 安装目录。请在终端运行 scripts/uninstall-workbench-patch.sh，然后重启 VS Code。",
    "复制命令"
  ).then(async (picked) => {
    if (picked === "复制命令") {
      await vscode.env.clipboard.writeText(`sudo bash ${shellQuote(`${extensionPath}/scripts/uninstall-workbench-patch.sh`)}`);
    }
  });
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

async function openPanel(): Promise<void> {
  await deckPanel?.show();
}

async function heartbeat(): Promise<void> {
  const staleAfterMs = getConfigNumber("staleAfterMs") || 20000;
  const data = await registry.read();
  for (const record of applyStaleState(data.windows, staleAfterMs, currentWindowId)) {
    if (record.state.stale && record.workspaceKind === "empty") {
      await registry.removeWindow(record.windowId);
    }
  }
  const previous = data.windows.find((record) => record.windowId === currentWindowId);
  const terminals = await terminalStatusTracker?.snapshot() ?? [];
  const record = buildWindowRecord(currentWindowId, currentTitleToken, staleAfterMs, previous, terminals);
  await registry.upsertWindow(record);
  await refreshStatus(record);
}

async function showWindows(): Promise<void> {
  await heartbeat();
  const staleAfterMs = getConfigNumber("staleAfterMs") || 20000;
  const data = await registry.read();
  const visible = visibleWindowRecords(applyStaleState(data.windows, staleAfterMs, currentWindowId));
  const layout = normalizeVisibleLayout(data.layout, visible);
  const ordered = orderVisibleRecords(visible, layout);
  if (!ordered.length) {
    await vscode.window.showInformationMessage("Window Deck 没有已注册的工作区窗口。");
    return;
  }
  const quickPick = vscode.window.createQuickPick<WindowQuickPickItem>();
  quickPick.title = "Window Deck";
  quickPick.placeholder = "选择窗口切换；右侧按钮可重命名、改色、删除或打开管理视图";
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.items = ordered.flatMap((record, index, records) => {
    const withSeparator: WindowQuickPickItem[] = [];
    if (index === 0 || records[index - 1].state.stale !== record.state.stale) {
      withSeparator.push({ label: record.state.stale ? "历史关闭" : "已打开", kind: vscode.QuickPickItemKind.Separator });
    }
    withSeparator.push(toQuickPickItem(record));
    return withSeparator;
  });
  quickPick.onDidAccept(() => {
    const selected = quickPick.selectedItems[0];
    quickPick.hide();
    if (selected?.record) {
      void activateQuickPickWindow(selected.record);
    }
  });
  quickPick.onDidTriggerItemButton((event) => {
    const record = event.item.record;
    if (!record) {
      return;
    }
    if (event.button.tooltip === "重命名") {
      void renameWindowFromPick(record);
    } else if (event.button.tooltip === "设置颜色") {
      void setWindowColorFromPick(record);
    } else if (event.button.tooltip === "删除记录") {
      void removeWindow(record.windowId);
      quickPick.items = quickPick.items.filter((item) => item.record?.windowId !== record.windowId);
    } else if (event.button.tooltip === "管理视图") {
      quickPick.hide();
      void deckPanel?.show();
    }
  });
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

async function activateQuickPickWindow(record: WindowRecord): Promise<void> {
  if (record.windowId === currentWindowId) {
    await configureCurrentWindow();
  } else if (record.state.stale) {
    await openWindow(record.windowId);
  } else {
    const result = await focusWindow(record);
    await handleFocusResult(record.windowId, result);
  }
}

type WindowQuickPickItem = vscode.QuickPickItem & { record?: WindowRecord };

const quickPickButtons = {
  rename: new vscode.ThemeIcon("edit"),
  color: new vscode.ThemeIcon("symbol-color"),
  remove: new vscode.ThemeIcon("trash"),
  manage: new vscode.ThemeIcon("list-tree")
};

function toQuickPickItem(record: WindowRecord): WindowQuickPickItem {
  const title = titleFromRecord(record.alias, record.workspaceName);
  const marker = record.windowId === currentWindowId ? "$(check)" : record.state.stale ? "$(history)" : "$(window)";
  const status = record.windowId === currentWindowId ? "当前" : record.state.stale ? "历史关闭" : "已打开";
  const terminalSummary = terminalQuickPickSummary(record.terminals);
  const terminalDetail = terminalQuickPickDetail(record.terminals);
  const detailParts = [remoteLabel(record), compactPath(record.workspaceUri), record.git?.branch, `活跃于 ${relativeAge(record.state.lastSeenAt)}`].filter(Boolean);
  return {
    label: `${marker} ${title}`,
    description: [status, terminalSummary, record.color ? `${colorName(record.color)} ${record.color}` : undefined].filter(Boolean).join(" · "),
    detail: [detailParts.join(" · "), terminalDetail].filter(Boolean).join("    "),
    buttons: [
      { iconPath: quickPickButtons.rename, tooltip: "重命名" },
      { iconPath: quickPickButtons.color, tooltip: "设置颜色" },
      ...(record.state.stale ? [{ iconPath: quickPickButtons.remove, tooltip: "删除记录" }] : []),
      { iconPath: quickPickButtons.manage, tooltip: "管理视图" }
    ],
    record
  };
}

async function renameWindowFromPick(record: WindowRecord): Promise<void> {
  const alias = await vscode.window.showInputBox({
    title: "Window Deck：重命名窗口",
    value: record.alias ?? record.workspaceName ?? "",
    prompt: "别名存储在 Window Deck 全局存储中，不会写入项目文件。"
  });
  if (alias !== undefined) {
    await renameWindow(record.windowId, alias);
  }
}

async function setWindowColorFromPick(record: WindowRecord): Promise<void> {
  const palette = ["#4f8cff", "#2fb344", "#f59f00", "#e03131", "#9c36b5", "#0ca678", "#f76707", "#495057"];
  const picked = await vscode.window.showQuickPick(
    palette.map((color) => ({ label: color, description: colorName(color), detail: record.windowId === currentWindowId ? "当前窗口" : titleFromRecord(record.alias, record.workspaceName) })),
    { title: "Window Deck：设置窗口颜色" }
  );
  if (picked) {
    await setWindowColor(record.windowId, picked.label);
  }
}

async function renameCurrentWindow(): Promise<void> {
  const data = await registry.read();
  const current = data.windows.find((record) => record.windowId === currentWindowId);
  const alias = await vscode.window.showInputBox({
    title: "Window Deck：重命名当前窗口",
    prompt: "别名存储在 Window Deck 全局存储中，不会写入项目文件。",
    value: current?.alias ?? current?.workspaceName ?? ""
  });
  if (alias === undefined) {
    return;
  }
  await renameWindow(currentWindowId, alias);
}

async function setCurrentWindowColor(): Promise<void> {
  const palette = ["#4f8cff", "#2fb344", "#f59f00", "#e03131", "#9c36b5", "#0ca678", "#f76707", "#495057"];
  const picked = await vscode.window.showQuickPick(
    palette.map((color) => ({ label: color, description: "Window Deck 界面颜色", detail: colorName(color) })),
    { title: "Window Deck：设置当前窗口颜色" }
  );
  if (!picked) {
    return;
  }
  await setWindowColor(currentWindowId, picked.label);
}

async function focusRegisteredWindow(windowId: string): Promise<void> {
  await heartbeat();
  if (windowId === currentWindowId) {
    return;
  }
  const data = await registry.read();
  const target = data.windows.find((record) => record.windowId === windowId);
  if (!target) {
    await vscode.window.showWarningMessage("Window Deck 找不到目标窗口。该窗口可能已关闭。");
    return;
  }
  const result = await focusWindow(target);
  await handleFocusResult(windowId, result);
}

async function openWindow(windowId: string): Promise<void> {
  const data = await registry.read();
  const target = data.windows.find((record) => record.windowId === windowId);
  if (!target?.workspaceUri) {
    await vscode.window.showWarningMessage("这个窗口没有可重新打开的 workspace 路径。");
    return;
  }
  try {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.parse(target.workspaceUri), true);
  } catch (error) {
    await vscode.window.showWarningMessage(`重新打开窗口失败：${(error as Error).message}`);
  }
}

async function renameWindow(windowId: string, alias: string): Promise<void> {
  await registry.saveUserConfig({ windowId, alias: alias.trim() || undefined });
  if (windowId === currentWindowId) {
    await applyCurrentWindowTitle({ silent: true });
    await heartbeat();
  }
  await deckPanel?.refresh();
}

async function removeWindow(windowId: string): Promise<void> {
  await registry.removeWindow(windowId);
  await deckPanel?.refresh();
}

async function setWindowColor(windowId: string, color: string): Promise<void> {
  await registry.saveUserConfig({ windowId, color });
  if (windowId === currentWindowId) {
    if (getConfigBoolean("applyWorkbenchColors")) {
      await applyWorkbenchColor(color);
    }
    await heartbeat();
  }
  await deckPanel?.refresh();
}

async function handleFocusResult(windowId: string, result: Awaited<ReturnType<typeof focusWindow>>): Promise<void> {
  if (!result.ok) {
    await vscode.window.showWarningMessage(result.reason, "诊断聚焦支持");
    return;
  }
  await markFocused(windowId);
  await deckPanel?.refresh();
}

async function configureCurrentWindow(): Promise<void> {
  await heartbeat();
  const data = await registry.read();
  const current = data.windows.find((record) => record.windowId === currentWindowId);
  const picked = await vscode.window.showQuickPick(
    [
      { label: "$(edit) 重命名", description: titleFromRecord(current?.alias, current?.workspaceName), action: "rename" },
      { label: "$(symbol-color) 设置颜色", description: current?.color ?? "未设置颜色", action: "color" },
      { label: "$(window) 应用窗口标题标记", description: `[${currentTitleToken}]`, action: "title" },
      { label: "$(symbol-color) 应用颜色到 VS Code 外观", description: "写入当前 workspace 的 workbench.colorCustomizations", action: "workbenchColor" },
      { label: "$(copy) 复制窗口信息", description: current?.workspaceName ?? "当前窗口", action: "copy" }
    ],
    { title: "Window Deck：配置当前窗口" }
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
      await vscode.window.showWarningMessage("请先设置 Window Deck 窗口颜色。");
      return;
    }
    await applyWorkbenchColor(current.color);
    await vscode.window.showInformationMessage("Window Deck 已为当前 workspace 写入 VS Code 外观颜色。");
  } else if (picked.action === "copy") {
    await vscode.env.clipboard.writeText(JSON.stringify(current, null, 2));
    await vscode.window.showInformationMessage("Window Deck 已复制当前窗口信息。");
  }
}

async function applyCurrentWindowTitle(options: { silent?: boolean } = {}): Promise<void> {
  const hasWorkspace = Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
  if (!hasWorkspace) {
    if (!options.silent) {
      await vscode.window.showWarningMessage("只有打开文件夹或 workspace 后，Window Deck 才能写入当前窗口的标题标记。");
    }
    return;
  }
  const data = await registry.read();
  const current = data.windows.find((record) => record.windowId === currentWindowId);
  const aliasOrRoot = current?.alias?.trim() || "${rootName}";
  const title = `${aliasOrRoot}${"${separator}${activeEditorShort}"} [${currentTitleToken}]`;
  await vscode.workspace.getConfiguration("window").update("title", title, vscode.ConfigurationTarget.Workspace);
  if (!options.silent) {
    await heartbeat();
    await vscode.window.showInformationMessage(`Window Deck 已应用 workspace 标题标记 [${currentTitleToken}]。`);
  }
}

async function cleanupStaleWindows(): Promise<void> {
  const removed = await registry.cleanup(getConfigNumber("removeStaleAfterMs") || 86400000);
  await vscode.window.showInformationMessage(`Window Deck 已清理 ${removed} 个失联窗口。`);
}

async function diagnoseFocusSupport(): Promise<void> {
  const data = await registry.read();
  const current = data.windows.find((record) => record.windowId === currentWindowId);
  const details = [
    focusSupportMessage(),
    `平台：${process.platform}`,
    `会话：${current?.platform.linuxSession ?? "n/a"}`,
    `桌面：${current?.platform.desktop ?? "n/a"}`,
    `标题标记：${currentTitleToken}`
  ].join("\n");
  await vscode.window.showInformationMessage(details, { modal: true });
}

async function ensureTitleToken(): Promise<void> {
  const shouldAutoApplyOnMacOS = process.platform === "darwin" && getConfigBoolean("autoApplyTitleMarkerOnMacOS");
  const shouldAutoApplyOnKdeWayland = process.platform === "linux" && linuxSession() === "wayland" && desktopEnvironment() === "kde" && getConfigBoolean("autoApplyTitleMarkerOnKdeWayland");
  if (shouldAutoApplyOnMacOS || shouldAutoApplyOnKdeWayland) {
    await applyCurrentWindowTitle({ silent: true });
    return;
  }
  if (getConfigString("titleTokenMode") !== "visible") {
    return;
  }
  await vscode.window.showWarningMessage(
    "Window Deck 不能安全地通过 VS Code 全局 window.title 注入唯一标题标记。本版本不会自动修改全局标题设置。"
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
    `当前：${title}`,
    `Workspace：${compactPath(record.workspaceUri)}`,
    `远程：${remoteLabel(record)}`,
    terminalQuickPickDetail(record.terminals) ?? "终端：无",
    "点击显示窗口下拉列表"
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

function colorName(color: string): string {
  const names: Record<string, string> = {
    "#4f8cff": "蓝色",
    "#2fb344": "绿色",
    "#f59f00": "琥珀色",
    "#e03131": "红色",
    "#9c36b5": "紫色",
    "#0ca678": "青绿色",
    "#f76707": "橙色",
    "#495057": "灰色"
  };
  return names[color] ?? "自定义";
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

function terminalQuickPickSummary(terminals: WindowTerminalRecord[] | undefined): string | undefined {
  const items = sortedTerminals(terminals);
  if (items.length === 0) {
    return undefined;
  }
  return items.map((terminal, index) => `${terminalCodicon(terminal.state)}${index + 1}`).join(" ");
}

function terminalQuickPickDetail(terminals: WindowTerminalRecord[] | undefined): string | undefined {
  const items = sortedTerminals(terminals);
  if (items.length === 0) {
    return undefined;
  }
  const counts = countTerminalsByState(items);
  const summary = [
    counts.running > 0 ? `${counts.running} 运行中` : undefined,
    counts.waitingInput > 0 ? `${counts.waitingInput} 等待输入` : undefined,
    counts.idle > 0 ? `${counts.idle} 空闲` : undefined
  ].filter(Boolean).join(" · ");
  return `终端：${summary}`;
}

function sortedTerminals(terminals: WindowTerminalRecord[] | undefined): WindowTerminalRecord[] {
  return [...(terminals ?? [])].sort((a, b) => a.order - b.order);
}

function countTerminalsByState(terminals: WindowTerminalRecord[]): Record<WindowTerminalRecord["state"], number> {
  return terminals.reduce<Record<WindowTerminalRecord["state"], number>>((counts, terminal) => {
    counts[terminal.state] += 1;
    return counts;
  }, { running: 0, waitingInput: 0, idle: 0 });
}

function terminalCodicon(state: WindowTerminalRecord["state"]): string {
  if (state === "running") {
    return "$(play)";
  }
  if (state === "waitingInput") {
    return "$(keyboard)";
  }
  return "$(terminal)";
}

function authorityName(authority?: string): string {
  if (!authority) {
    return "unknown";
  }
  return authority.split("+").pop() ?? authority;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
