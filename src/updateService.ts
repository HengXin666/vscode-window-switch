import * as fs from "node:fs/promises";
import * as https from "node:https";
import * as path from "node:path";
import * as vscode from "vscode";

type GitHubRelease = {
  tag_name: string;
  html_url: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
};

const latestReleaseUrl = "https://api.github.com/repos/HengXin666/vscode-window-switch/releases/latest";
const checkIntervalMs = 24 * 60 * 60 * 1000;

export async function checkForUpdates(
  context: vscode.ExtensionContext,
  options: { manual?: boolean; onInstalled(): Promise<void> }
): Promise<void> {
  const currentVersion = extensionVersion(context);
  const lastCheckKey = "windowDeck.lastUpdateCheckAt";
  const lastCheckAt = context.globalState.get<number>(lastCheckKey) ?? 0;
  if (!options.manual && Date.now() - lastCheckAt < checkIntervalMs) {
    return;
  }
  await context.globalState.update(lastCheckKey, Date.now());

  let release: GitHubRelease;
  try {
    release = await requestJson<GitHubRelease>(latestReleaseUrl);
  } catch (error) {
    if (options.manual) {
      await vscode.window.showWarningMessage(`检查 Window Deck 更新失败：${(error as Error).message}`);
    }
    return;
  }

  const latestVersion = normalizeVersion(release.tag_name);
  if (!isNewerVersion(latestVersion, currentVersion)) {
    if (options.manual) {
      await vscode.window.showInformationMessage(`Window Deck 已是最新版（${currentVersion}）。`);
    }
    return;
  }

  const ignoredVersion = context.globalState.get<string>("windowDeck.ignoredUpdateVersion");
  if (!options.manual && ignoredVersion === latestVersion) {
    return;
  }

  const asset = release.assets.find((item) => item.name.toLowerCase().endsWith(".vsix"));
  const actions = asset ? ["下载并安装", "查看发布说明", "忽略此版本"] : ["查看发布说明", "忽略此版本"];
  const picked = await vscode.window.showInformationMessage(
    `Window Deck ${latestVersion} 已发布，当前版本为 ${currentVersion}。`,
    ...actions
  );
  if (picked === "查看发布说明") {
    await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
    return;
  }
  if (picked === "忽略此版本") {
    await context.globalState.update("windowDeck.ignoredUpdateVersion", latestVersion);
    return;
  }
  if (picked !== "下载并安装" || !asset) {
    return;
  }

  try {
    await installRelease(context, latestVersion, asset.browser_download_url);
  } catch (error) {
    await vscode.window.showErrorMessage(`Window Deck ${latestVersion} 安装失败：${(error as Error).message}`);
    return;
  }

  const reload = await vscode.window.showInformationMessage(
    `Window Deck ${latestVersion} 已安装。重载所有 VS Code 窗口后即可应用更新。`,
    "一键重载所有窗口",
    "稍后"
  );
  if (reload === "一键重载所有窗口") {
    await options.onInstalled();
  }
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const packageJson = context.extension.packageJSON as { version?: unknown };
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

async function installRelease(context: vscode.ExtensionContext, version: string, downloadUrl: string): Promise<void> {
  const updateDirectory = path.join(context.globalStorageUri.fsPath, "updates");
  const vsixPath = path.join(updateDirectory, `window-deck-${version}.vsix`);
  await fs.mkdir(updateDirectory, { recursive: true });
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在下载 Window Deck ${version}`,
      cancellable: false
    },
    async () => {
      const data = await requestBuffer(downloadUrl);
      await fs.writeFile(vsixPath, data);
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsixPath));
    }
  );
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "").split("-")[0];
}

function isNewerVersion(candidate: string, current: string): boolean {
  const left = candidate.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = normalizeVersion(current).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return false;
}

function requestJson<T>(url: string): Promise<T> {
  return requestBuffer(url).then((data) => JSON.parse(data.toString("utf8")) as T);
}

function requestBuffer(url: string, redirectsRemaining = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "window-deck-vscode-extension"
        },
        timeout: 15000
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && redirectsRemaining > 0) {
          response.resume();
          resolve(requestBuffer(new URL(location, url).toString(), redirectsRemaining - 1));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const data = Buffer.concat(chunks);
          if (status < 200 || status >= 300) {
            reject(new Error(`GitHub 返回 HTTP ${status}`));
            return;
          }
          resolve(data);
        });
        response.on("error", reject);
      }
    );
    request.on("timeout", () => request.destroy(new Error("请求超时")));
    request.on("error", reject);
  });
}
