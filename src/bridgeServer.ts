import * as http from "node:http";
import * as vscode from "vscode";

import { Registry } from "./registry";
import { WindowDeckLayout, WindowRecord } from "./types";
import { applyStaleState } from "./windowMetadata";

type BridgeActions = {
  focusWindow(windowId: string): Promise<void>;
  openWindow(windowId: string): Promise<void>;
  renameWindow(windowId: string, alias: string): Promise<void>;
  setWindowColor(windowId: string, color: string): Promise<void>;
  removeWindow(windowId: string): Promise<void>;
  saveLayout(layout: WindowDeckLayout): Promise<void>;
  refreshCurrentWindow(): Promise<void>;
};

export class BridgeServer implements vscode.Disposable {
  public static readonly port = 39417;
  private server?: http.Server;

  public constructor(
    private readonly registry: Registry,
    private readonly currentWindowId: () => string,
    private readonly staleAfterMs: () => number,
    private readonly actions: BridgeActions
  ) {}

  public async start(context: vscode.ExtensionContext): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(BridgeServer.port, "127.0.0.1", () => resolve());
    });
    await context.globalState.update("windowDeck.bridgePort", BridgeServer.port);
  }

  public dispose(): void {
    this.server?.close();
    this.server = undefined;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${BridgeServer.port}`);
      if (request.method === "GET" && url.pathname === "/state") {
        await this.actions.refreshCurrentWindow();
        const data = await this.registry.read();
        const windows = orderWindows(applyStaleState(data.windows, this.staleAfterMs(), this.currentWindowId()), data.layout.order);
        this.json(response, {
          currentWindowId: this.currentWindowId(),
          layout: data.layout,
          windows: windows.map(toBridgeRecord)
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/action") {
        const body = await readBody(request);
        await this.applyAction(JSON.parse(body || "{}") as Record<string, unknown>);
        this.json(response, { ok: true });
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      this.json(response, { ok: false, error: (error as Error).message }, 500);
    }
  }

  private async applyAction(action: Record<string, unknown>): Promise<void> {
    const type = String(action.type ?? "");
    const windowId = typeof action.windowId === "string" ? action.windowId : undefined;
    if (type === "layout" && isLayout(action.layout)) {
      await this.actions.saveLayout(action.layout);
    } else if (windowId && type === "focus") {
      await this.actions.focusWindow(windowId);
    } else if (windowId && type === "open") {
      await this.actions.openWindow(windowId);
    } else if (windowId && type === "remove") {
      await this.actions.removeWindow(windowId);
    } else if (windowId && type === "rename" && typeof action.alias === "string") {
      await this.actions.renameWindow(windowId, action.alias);
    } else if (windowId && type === "color" && typeof action.color === "string") {
      await this.actions.setWindowColor(windowId, action.color);
    }
  }

  private json(response: http.ServerResponse, data: unknown, status = 200): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(data));
  }
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function orderWindows(windows: WindowRecord[], order: string[]): WindowRecord[] {
  const index = new Map(order.map((windowId, position) => [windowId, position]));
  return [...windows].sort((a, b) => {
    const aIndex = index.get(a.windowId) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = index.get(b.windowId) ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }
    if (a.state.stale !== b.state.stale) {
      return a.state.stale ? 1 : -1;
    }
    return (b.state.lastFocusedAt ?? b.state.lastSeenAt) - (a.state.lastFocusedAt ?? a.state.lastSeenAt);
  });
}

function toBridgeRecord(record: WindowRecord): Record<string, unknown> {
  return {
    windowId: record.windowId,
    title: record.alias || record.workspaceName || "空窗口",
    color: record.color ?? "#4f8cff",
    stale: record.state.stale,
    workspaceKind: record.workspaceKind,
    workspaceUri: record.workspaceUri,
    remoteKind: record.remote.kind,
    branch: record.git?.branch
  };
}

function isLayout(value: unknown): value is WindowDeckLayout {
  if (!value || typeof value !== "object") {
    return false;
  }
  const layout = value as WindowDeckLayout;
  return Array.isArray(layout.order) && Array.isArray(layout.groups);
}
