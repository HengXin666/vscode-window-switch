import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { FocusResult, WindowRecord } from "./types";
import { desktopEnvironment, linuxSession } from "./util";

export async function focusWindow(record: WindowRecord): Promise<FocusResult> {
  const titleCandidates = candidateTitles(record);
  if (titleCandidates.length === 0) {
    return { ok: false, reason: "目标窗口缺少可用于匹配 OS 窗口标题的信息。" };
  }
  if (process.platform === "darwin") {
    return focusMac(titleCandidates);
  }
  if (process.platform === "linux") {
    if (linuxSession() === "wayland") {
      if (desktopEnvironment() === "kde") {
        return focusKdeWayland(titleCandidates);
      }
      return waylandUnsupportedResult();
    }
    return focusLinuxX11(titleCandidates);
  }
  return { ok: false, reason: `当前平台 ${process.platform} 暂不支持自动聚焦。` };
}

export function focusSupportMessage(): string {
  if (process.platform === "darwin") {
    return "macOS: 使用 AppleScript fallback 按标题 token 聚焦。若失败，请检查系统辅助功能权限。";
  }
  if (process.platform === "linux") {
    const session = linuxSession();
    if (session === "x11") {
      return "Linux X11: 支持通过 wmctrl 或 xdotool 按标题 token 聚焦。请确认至少安装其中一个工具。";
    }
    if (session === "wayland") {
      if (desktopEnvironment() === "kde") {
        return "Linux Wayland KDE: 通过 KWin D-Bus 脚本接口 best-effort 聚焦。需要 qdbus6 或 qdbus 可用。";
      }
      return "Linux Wayland: 支持窗口索引、命名和颜色；自动聚焦受桌面安全模型限制，仅 best-effort。";
    }
    return "Linux: 无法判断当前是 X11 还是 Wayland，自动聚焦能力未知。";
  }
  return `当前平台 ${process.platform} 暂不支持自动聚焦。`;
}

function focusMac(titleCandidates: string[]): Promise<FocusResult> {
  const candidates = titleCandidates.map(escapeAppleScript).map((item) => `"${item}"`).join(", ");
  const script = `
tell application "System Events"
  set targetTokens to {${candidates}}
  repeat with proc in (application processes whose name contains "Code" or name contains "Visual Studio Code")
    repeat with win in windows of proc
      repeat with targetToken in targetTokens
        if name of win contains targetToken then
          set frontmost of proc to true
          perform action "AXRaise" of win
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "not-found"
`;
  return execFile("osascript", ["-e", script]).then((output) => {
    if (output.trim() === "ok") {
      return { ok: true };
    }
    return { ok: false, reason: "Window Deck 找不到目标窗口。该窗口可能已关闭，或标题 token 被覆盖。" };
  });
}

async function focusLinuxX11(titleCandidates: string[]): Promise<FocusResult> {
  const wmctrl = await commandExists("wmctrl");
  if (wmctrl) {
    for (const title of titleCandidates) {
      const result = await execFile("wmctrl", ["-a", title]).catch((error: Error) => error.message);
      if (typeof result === "string" && result.length === 0) {
        return { ok: true };
      }
    }
  }

  const xdotool = await commandExists("xdotool");
  if (xdotool) {
    for (const title of titleCandidates) {
      const search = await execFile("xdotool", ["search", "--name", title]).catch(() => "");
      const windowId = search.split(/\s+/).find(Boolean);
      if (windowId) {
        await execFile("xdotool", ["windowactivate", windowId]).catch(() => "");
        return { ok: true };
      }
    }
  }

  return {
    ok: false,
    reason: "Linux X11 聚焦需要 wmctrl 或 xdotool fallback。未找到可用工具，或目标窗口标题未匹配。"
  };
}

async function focusKdeWayland(titleCandidates: string[]): Promise<FocusResult> {
  const qdbus = (await findCommand(["qdbus6", "qdbus"]));
  if (!qdbus) {
    return {
      ok: false,
      reason: "当前 KDE Wayland 环境可通过 KWin 脚本 best-effort 聚焦，但未找到 qdbus6/qdbus。请安装 Qt D-Bus 工具后重试。"
    };
  }

  const pluginName = `window-deck-focus-${process.pid}-${Date.now()}`;
  const scriptPath = path.join(os.tmpdir(), `${pluginName}.js`);
  await fs.writeFile(scriptPath, kwinFocusScript(titleCandidates), "utf8");

  try {
    const scriptId = await execFile(qdbus, ["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", scriptPath, pluginName]);
    const id = scriptId.trim();
    if (!/^\d+$/.test(id)) {
      throw new Error(`KWin did not return a script id: ${scriptId}`);
    }
    await execFile(qdbus, ["org.kde.KWin", `/Scripting/Script${id}`, "org.kde.kwin.Script.run"]);
    setTimeout(() => {
      void execFile(qdbus, ["org.kde.KWin", `/Scripting/Script${id}`, "org.kde.kwin.Script.stop"]).finally(() => {
        void execFile(qdbus, ["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", pluginName]);
        void fs.rm(scriptPath, { force: true });
      });
    }, 1000);
    return { ok: true };
  } catch (error) {
    await fs.rm(scriptPath, { force: true });
    return {
      ok: false,
      reason: `KDE Wayland 聚焦请求失败：${(error as Error).message}`
    };
  }
}

function execFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { timeout: 3000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function commandExists(command: string): Promise<boolean> {
  return (await findCommand([command])) !== undefined;
}

async function findCommand(commands: string[]): Promise<string | undefined> {
  for (const command of commands) {
    if (path.isAbsolute(command)) {
      return command;
    }
    const found = await which(command);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function which(command: string): Promise<string | undefined> {
  try {
    const output = await execFile("which", [command]);
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function candidateTitles(record: WindowRecord): string[] {
  const pathName = record.workspaceUri?.split("/").filter(Boolean).pop();
  return [record.titleToken, record.alias, record.workspaceName, pathName]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .filter((value, index, all) => all.indexOf(value) === index);
}

function waylandUnsupportedResult(): FocusResult {
  return {
    ok: false,
    reason: "当前 Linux Wayland 环境通常不允许外部程序强制切换窗口。Window Deck 仍可作为窗口索引器使用。"
  };
}

function kwinFocusScript(titleCandidates: string[]): string {
  return `
const needles = ${JSON.stringify(titleCandidates)};

function listWindows() {
  if (typeof workspace.windowList === "function") {
    return workspace.windowList();
  }
  if (typeof workspace.clientList === "function") {
    return workspace.clientList();
  }
  return [];
}

function windowCaption(win) {
  try {
    return String(win.caption || "");
  } catch (error) {
    return "";
  }
}

function onCurrentDesktop(win) {
  try {
    if (!workspace.currentDesktop || !win.desktops || win.desktops.length === 0) {
      return true;
    }
    return win.desktops.some((desktop) => desktop.id === workspace.currentDesktop.id);
  } catch (error) {
    return true;
  }
}

for (const win of listWindows()) {
  const caption = windowCaption(win);
  if (!caption || !needles.some((needle) => caption.includes(needle))) {
    continue;
  }

  try {
    if (win.minimized) {
      win.minimized = false;
    }
  } catch (error) {}

  try {
    if (!onCurrentDesktop(win) && win.desktops && win.desktops.length > 0) {
      workspace.currentDesktop = win.desktops[0];
    }
  } catch (error) {}

  try {
    workspace.activeWindow = win;
  } catch (error) {}

  try {
    workspace.raiseWindow(win);
  } catch (error) {}

  try {
    workspace.forceActiveWindow = win;
  } catch (error) {}

  break;
}
`;
}
