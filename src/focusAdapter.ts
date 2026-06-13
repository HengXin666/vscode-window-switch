import * as childProcess from "node:child_process";

import { FocusResult, WindowRecord } from "./types";
import { linuxSession } from "./util";

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
      return {
        ok: false,
        reason: "当前 Linux Wayland 环境通常不允许外部程序强制切换窗口。Window Deck 仍可作为窗口索引器使用。"
      };
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
  try {
    await execFile("command", ["-v", command]);
    return true;
  } catch {
    try {
      await execFile("which", [command]);
      return true;
    } catch {
      return false;
    }
  }
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function candidateTitles(record: WindowRecord): string[] {
  return [record.titleToken, record.alias, record.workspaceName]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}
