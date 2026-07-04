import * as childProcess from "node:child_process";
import * as vscode from "vscode";

import { RemoteKind, WindowRecord, WindowTerminalRecord, WorkspaceKind } from "./types";
import { desktopEnvironment, linuxSession, now, osKind } from "./util";

export function buildWindowRecord(
  windowId: string,
  titleToken: string,
  staleAfterMs: number,
  previous?: WindowRecord,
  terminals: WindowTerminalRecord[] = []
): WindowRecord {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const workspaceFile = vscode.workspace.workspaceFile;
  const workspaceKind: WorkspaceKind = workspaceFile ? "workspace" : workspaceFolders.length > 0 ? "folder" : "empty";
  const primaryFolder = workspaceFolders[0];
  const workspaceName = workspaceFile ? trimWorkspaceName(workspaceFile) : primaryFolder?.name;
  const workspaceUri = workspaceFile?.toString() ?? primaryFolder?.uri.toString();
  const remote = detectRemote();
  const seenAt = now();

  return {
    windowId,
    pid: process.pid,
    titleToken,
    alias: previous?.alias,
    color: previous?.color,
    tags: previous?.tags ?? [],
    workspaceKind,
    workspaceName,
    workspaceUri,
    workspaceFolders: workspaceFolders.map((folder) => ({
      name: folder.name,
      uri: folder.uri.toString()
    })),
    remote,
    git: {
      branch: readGitBranch(primaryFolder?.uri),
      repoRoot: primaryFolder?.uri.toString()
    },
    terminals,
    state: {
      focused: true,
      active: true,
      stale: seenAt - (previous?.state.lastSeenAt ?? seenAt) > staleAfterMs,
      lastSeenAt: seenAt,
      lastFocusedAt: seenAt
    },
    platform: {
      os: osKind(),
      linuxSession: linuxSession(),
      desktop: desktopEnvironment()
    }
  };
}

export function applyStaleState(records: WindowRecord[], staleAfterMs: number, currentWindowId?: string): WindowRecord[] {
  const cutoff = now() - staleAfterMs;
  return records.map((record) => ({
    ...record,
    state: {
      ...record.state,
      focused: record.windowId === currentWindowId,
      active: record.state.lastSeenAt >= cutoff,
      stale: record.state.lastSeenAt < cutoff
    }
  }));
}

function trimWorkspaceName(uri: vscode.Uri): string {
  const basename = uri.path.split("/").filter(Boolean).pop() ?? "Workspace";
  return basename.replace(/\.code-workspace$/i, "");
}

function detectRemote(): WindowRecord["remote"] {
  const remoteName = vscode.env.remoteName;
  const remoteAuthority = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.authority.length > 0)?.uri.authority;
  if (!remoteName && !remoteAuthority) {
    return { kind: "local" };
  }
  return {
    kind: remoteKind(remoteName, remoteAuthority),
    remoteName,
    remoteAuthority
  };
}

function remoteKind(remoteName?: string, remoteAuthority?: string): RemoteKind {
  const value = `${remoteName ?? ""} ${remoteAuthority ?? ""}`.toLowerCase();
  if (value.includes("ssh")) {
    return "ssh";
  }
  if (value.includes("wsl")) {
    return "wsl";
  }
  if (value.includes("dev-container") || value.includes("attached-container")) {
    return "dev-container";
  }
  if (value.includes("codespaces")) {
    return "codespaces";
  }
  return "unknown";
}

function readGitBranch(folderUri?: vscode.Uri): string | undefined {
  if (!folderUri || folderUri.scheme !== "file") {
    return undefined;
  }
  try {
    const output = childProcess.execFileSync("git", ["-C", folderUri.fsPath, "branch", "--show-current"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}
