import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { DesktopEnvironment, LinuxSession, OperatingSystem } from "./types";

export function randomId(bytes = 8): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function now(): number {
  return Date.now();
}

export function getConfigNumber(key: string): number {
  return vscode.workspace.getConfiguration("windowDeck").get<number>(key) ?? 0;
}

export function getConfigBoolean(key: string): boolean {
  return vscode.workspace.getConfiguration("windowDeck").get<boolean>(key) ?? false;
}

export function getConfigString(key: string): string {
  return vscode.workspace.getConfiguration("windowDeck").get<string>(key) ?? "";
}

export function osKind(): OperatingSystem {
  if (process.platform === "darwin") {
    return "darwin";
  }
  if (process.platform === "linux") {
    return "linux";
  }
  return "unsupported";
}

export function linuxSession(): LinuxSession {
  if (process.platform !== "linux") {
    return "unknown";
  }
  const session = (process.env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (session === "x11" || session === "wayland") {
    return session;
  }
  if (process.env.WAYLAND_DISPLAY) {
    return "wayland";
  }
  if (process.env.DISPLAY) {
    return "x11";
  }
  return "unknown";
}

export function desktopEnvironment(): DesktopEnvironment {
  const value = `${process.env.XDG_CURRENT_DESKTOP ?? ""} ${process.env.DESKTOP_SESSION ?? ""}`.toLowerCase();
  if (value.includes("gnome")) {
    return "gnome";
  }
  if (value.includes("kde") || value.includes("plasma")) {
    return "kde";
  }
  if (value.includes("sway")) {
    return "sway";
  }
  return "unknown";
}

export function compactPath(uriText?: string): string {
  if (!uriText) {
    return "-";
  }
  try {
    const uri = vscode.Uri.parse(uriText);
    if (uri.scheme !== "file") {
      return uri.path || uriText;
    }
    const home = os.homedir();
    return uri.fsPath.startsWith(home) ? `~${uri.fsPath.slice(home.length)}` : uri.fsPath;
  } catch {
    return uriText.replace(os.homedir(), "~");
  }
}

export function registryDirectory(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "registry");
}

export function titleFromRecord(alias: string | undefined, workspaceName: string | undefined): string {
  return alias || workspaceName || "Empty Window";
}

export function relativeAge(timestamp?: number): string {
  if (!timestamp) {
    return "never";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}
