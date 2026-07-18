import * as vscode from "vscode";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { GitHubVsixUpdateManager } from "./vendor/githubUpdater";
import { BridgeServer } from "./bridgeServer";
import { focusSupportMessage, focusWindow } from "./focusAdapter";
import { Registry } from "./registry";
import { WindowRecord, WindowTerminalRecord } from "./types";
import { TerminalStatusTracker } from "./terminalStatus";
import { applyStaleState, buildWindowRecord } from "./windowMetadata";
import { compactPath, getConfigBoolean, getConfigNumber, randomId, registryDirectory, relativeAge, titleFromRecord } from "./util";
import { normalizeVisibleLayout, orderVisibleRecords, visibleWindowRecords } from "./windowView";
import { WindowDeckPanel } from "./windowDeckPanel";
import { TerminalStreamHub } from "./terminalStream";

let heartbeatTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let registry: Registry;
let currentWindowId: string;
let currentTitleToken: string;
let deckPanel: WindowDeckPanel | undefined;
let bridgeServer: BridgeServer | undefined;
let terminalStatusTracker: TerminalStatusTracker | undefined;
let terminalStreamHub: TerminalStreamHub | undefined;
let updateManager: GitHubVsixUpdateManager;
let extensionPath: string;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionPath = context.extensionPath;
  registry = new Registry(registryDirectory(context));
  currentWindowId = await resolveCurrentWindowId();
  currentTitleToken = `WD:${randomId(5)}`;

  await migrateLegacyWorkspaceTitle();
  terminalStreamHub = new TerminalStreamHub(currentWindowId, {
    onData: (windowId, terminalId, data) => deckPanel?.pushTerminalData(windowId, terminalId, data),
    onInput: (terminalId, data) => {
      if (!terminalStatusTracker?.sendText(terminalId, data, false)) {
        void vscode.window.showInformationMessage("这个命令行窗口已经关闭或正在刷新，请稍后再试。");
      }
    }
  });
  await terminalStreamHub.start();
  context.subscriptions.push(terminalStreamHub);
  terminalStatusTracker = new TerminalStatusTracker((terminalId, data) => terminalStreamHub?.publishData(terminalId, data));
  context.subscriptions.push(terminalStatusTracker);
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "windowDeck.showWindows";
  context.subscriptions.push(statusBarItem);
  deckPanel = new WindowDeckPanel(context.extensionUri, registry, () => currentWindowId, () => getConfigNumber("staleAfterMs") || 20000, {
    checkForUpdates: () => updateManager.checkForUpdates({ manual: true }),
    focusWindow: focusRegisteredWindow,
    focusTerminal,
    sendTerminalText,
    openWindow,
    renameWindow,
    setWindowColor,
    removeWindow,
    saveLayout: (layout) => registry.saveLayout(layout),
    refreshCurrentWindow: heartbeat,
    getTerminalReplay: (windowId, terminalId) => terminalStreamHub?.getReplay(windowId, terminalId) ?? ""
  });
  bridgeServer = new BridgeServer(registry, () => currentWindowId, () => getConfigNumber("staleAfterMs") || 20000, {
    focusWindow: focusRegisteredWindow,
    focusTerminal,
    openWindow,
    renameWindow,
    setWindowColor,
    removeWindow,
    saveLayout: (layout) => registry.saveLayout(layout),
    refreshCurrentWindow: heartbeat
  });
  await bridgeServer.start(context);
  context.subscriptions.push(bridgeServer);
  updateManager = new GitHubVsixUpdateManager(context, {
    owner: "HengXin666",
    repo: "vscode-window-switch",
    displayName: "Window Deck",
    stateKeyPrefix: "windowDeck.updater"
  });
  context.subscriptions.push(updateManager);

  const syncAutomaticChecks = (): void => {
    // Every UI window keeps the timer alive. The updater's shared atomic lock
    // guarantees that only one window performs the GitHub request per cycle,
    // so automatic checks continue even if the window that owns the bridge closes.
    updateManager.setAutomaticChecksEnabled(getConfigBoolean("autoCheckUpdates"));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("windowDeck.installWorkbenchPatch", installWorkbenchPatch),
    vscode.commands.registerCommand("windowDeck.uninstallWorkbenchPatch", uninstallWorkbenchPatch),
    vscode.commands.registerCommand("windowDeck.openPanel", openPanel),
    vscode.commands.registerCommand("windowDeck.showWindows", showWindows),
    vscode.commands.registerCommand("windowDeck.renameCurrentWindow", renameCurrentWindow),
    vscode.commands.registerCommand("windowDeck.setCurrentWindowColor", setCurrentWindowColor),
    vscode.commands.registerCommand("windowDeck.configureCurrentWindow", configureCurrentWindow),
    vscode.commands.registerCommand("windowDeck.cleanupStaleWindows", cleanupStaleWindows),
    vscode.commands.registerCommand("windowDeck.diagnoseFocusSupport", diagnoseFocusSupport),
    vscode.commands.registerCommand("windowDeck.checkForUpdates", () => updateManager.checkForUpdates({ manual: true })),
    vscode.commands.registerCommand("windowDeck.reloadAllWindows", () => updateManager.requestReloadAllWindows()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("windowDeck.autoCheckUpdates")) {
        syncAutomaticChecks();
      }
    })
  );

  await heartbeat();
  syncAutomaticChecks();
  const interval = Math.max(1000, getConfigNumber("heartbeatIntervalMs") || 5000);
  heartbeatTimer = setInterval(() => {
    void heartbeat();
  }, interval);
}

async function installWorkbenchPatch(): Promise<void> {
  const script = patchScriptPath("install");
  try {
    await runElevatedScript(script);
    await setLocalTerminalApiDeclaration(true);
    const picked = await vscode.window.showInformationMessage("Window Deck 已获得原始终端数据权限。请完全退出并重新打开 VS Code，之后正常启动即可。", "退出 VS Code");
    if (picked === "退出 VS Code") await vscode.commands.executeCommand("workbench.action.quit");
  } catch (error) {
    await vscode.window.showErrorMessage(`安装 Window Deck 终端权限失败：${(error as Error).message}`, "复制命令").then(async (picked) => {
      if (picked === "复制命令") await vscode.env.clipboard.writeText(elevatedScriptCommand(script));
    });
  }
}

async function uninstallWorkbenchPatch(): Promise<void> {
  const script = patchScriptPath("uninstall");
  try {
    await runElevatedScript(script);
    await setLocalTerminalApiDeclaration(false);
    const picked = await vscode.window.showInformationMessage("Window Deck 终端权限已移除。请完全退出并重新打开 VS Code。", "退出 VS Code");
    if (picked === "退出 VS Code") await vscode.commands.executeCommand("workbench.action.quit");
  } catch (error) {
    await vscode.window.showErrorMessage(`卸载 Window Deck 终端权限失败：${(error as Error).message}`, "复制命令").then(async (picked) => {
      if (picked === "复制命令") await vscode.env.clipboard.writeText(elevatedScriptCommand(script));
    });
  }
}

async function setLocalTerminalApiDeclaration(enabled: boolean): Promise<void> {
  const manifestPath = path.join(extensionPath, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { enabledApiProposals?: string[] };
  const current = Array.isArray(manifest.enabledApiProposals) ? manifest.enabledApiProposals : [];
  const proposals = current.filter((proposal) => proposal !== "terminalDataWriteEvent");
  if (enabled) proposals.push("terminalDataWriteEvent");
  if (proposals.length > 0) manifest.enabledApiProposals = proposals;
  else delete manifest.enabledApiProposals;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function runElevatedScript(script: string): Promise<void> {
  if (process.platform === "win32") {
    return runProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]);
  }
  if (process.platform === "darwin") {
    const escaped = script.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return runProcess("osascript", ["-e", `do shell script "bash " & quoted form of "${escaped}" with administrator privileges`]);
  }
  return runProcess("pkexec", ["bash", script]);
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, { timeout: 30_000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}

function patchScriptPath(action: "install" | "uninstall"): string {
  const extension = process.platform === "win32" ? ".ps1" : ".sh";
  return `${extensionPath}/scripts/${action}-workbench-patch${extension}`;
}

function elevatedScriptCommand(script: string): string {
  if (process.platform === "win32") return `powershell -ExecutionPolicy Bypass -File "${script}"`;
  if (process.platform === "darwin") return `osascript -e 'do shell script "bash " & quoted form of "${script.replace(/'/g, "'\\''")}" with administrator privileges'`;
  return `sudo bash ${shellQuote(script)}`;
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

async function resolveCurrentWindowId(): Promise<string> {
  const workspaceUri = vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
  if (!workspaceUri) {
    return `empty-${process.pid}-${randomId(8)}`;
  }
  const data = await registry.read();
  const previous = data.windows
    .filter((record) => record.workspaceUri === workspaceUri)
    .sort((left, right) => right.state.lastSeenAt - left.state.lastSeenAt)[0];
  return previous?.windowId ?? `workspace-${randomId(8)}`;
}

async function migrateLegacyWorkspaceTitle(): Promise<void> {
  try {
    const configuration = vscode.workspace.getConfiguration("window");
    const workspaceTitle = configuration.inspect<string>("title")?.workspaceValue;
    if (typeof workspaceTitle !== "string" || !/\[WD:[a-f0-9]+\]\s*$/i.test(workspaceTitle)) {
      return;
    }

    await configuration.update("title", undefined, vscode.ConfigurationTarget.Workspace);
    if (vscode.workspace.workspaceFile || !vscode.workspace.workspaceFolders?.length) {
      return;
    }

    const settingsDirectory = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ".vscode");
    const settingsFile = vscode.Uri.joinPath(settingsDirectory, "settings.json");
    const contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(settingsFile));
    if (!/^\s*\{\s*\}\s*$/.test(contents)) {
      return;
    }
    await vscode.workspace.fs.delete(settingsFile);
    if ((await vscode.workspace.fs.readDirectory(settingsDirectory)).length === 0) {
      await vscode.workspace.fs.delete(settingsDirectory);
    }
  } catch (error) {
    console.warn("Window Deck could not migrate legacy workspace settings", error);
  }
}

async function openPanel(): Promise<void> {
  if (terminalStreamHub?.isPrimary && terminalStatusTracker && !terminalStatusTracker.supportsLiveData) {
    await vscode.window.showWarningMessage(
      "Window Deck 未获得 VS Code 原始终端数据权限；合并终端不会实时同步。请运行“Window Deck: 安装原生终端同步权限”，然后完全重启 VS Code。"
    );
  }
  await deckPanel?.show();
}

async function focusTerminal(windowId: string, terminalId: string): Promise<void> {
  if (windowId !== currentWindowId) {
    await focusRegisteredWindow(windowId);
    await vscode.commands.executeCommand("workbench.action.terminal.focus");
    return;
  }
  if (!(await terminalStatusTracker?.focusTerminal(terminalId))) {
    await vscode.window.showInformationMessage("这个命令行窗口已经关闭或正在刷新，请稍后再试。");
  }
}

async function sendTerminalText(windowId: string, terminalId: string, text: string, shouldExecute: boolean): Promise<void> {
  if (windowId !== currentWindowId) {
    terminalStreamHub?.sendInput(windowId, terminalId, text);
    return;
  }
  if (!terminalStatusTracker?.sendText(terminalId, text, shouldExecute)) {
    await vscode.window.showInformationMessage("这个命令行窗口已经关闭或正在刷新，请稍后再试。");
  }
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
    return;
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
  } else if (picked.action === "copy") {
    await vscode.env.clipboard.writeText(JSON.stringify(current, null, 2));
    await vscode.window.showInformationMessage("Window Deck 已复制当前窗口信息。");
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
    `本地窗口 ID：${currentWindowId}`
  ].join("\n");
  await vscode.window.showInformationMessage(details, { modal: true });
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
  const commands = items
    .map((terminal, index) => `${index + 1}. ${terminal.commandLine || terminal.name || terminal.shell || "terminal"}`)
    .join("  |  ");
  return `终端：${summary}    命令：${commands}`;
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
