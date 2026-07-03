import * as http from "node:http";
import * as vscode from "vscode";

import { Registry } from "./registry";
import { WindowDeckLayout, WindowRecord } from "./types";
import { applyStaleState } from "./windowMetadata";
import { normalizeVisibleLayout, orderVisibleRecords, visibleWindowRecords } from "./windowView";

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
  private commandSeq = 0;
  private commandIssuedAt = 0;
  private overlayAckSeq = 0;
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
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        this.server?.close();
        this.server = undefined;
        return;
      }
      throw error;
    });
    await context.globalState.update("windowDeck.bridgePort", BridgeServer.port);
  }

  public dispose(): void {
    this.server?.close();
    this.server = undefined;
  }

  public async toggleOverlay(): Promise<boolean> {
    if (this.server) {
      const seq = this.nextCommandSeq();
      return this.waitForOverlayAck(seq);
    }
    return postLocalToggle();
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
        const visible = visibleWindowRecords(applyStaleState(data.windows, this.staleAfterMs(), this.currentWindowId()));
        const layout = normalizeVisibleLayout(data.layout, visible);
        const windows = orderVisibleRecords(visible, layout);
        const displayLayout = {
          ...layout,
          order: windows.map((record) => record.windowId)
        };
        this.json(response, {
          currentWindowId: this.currentWindowId(),
          layout: displayLayout,
          windows: windows.map(toBridgeRecord)
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/command") {
        this.json(response, { seq: this.commandSeq, issuedAt: this.commandIssuedAt });
        return;
      }
      if (request.method === "POST" && url.pathname === "/toggle") {
        const seq = this.nextCommandSeq();
        const ack = await this.waitForOverlayAck(seq);
        this.json(response, { ok: ack });
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
    if (type === "toggle") {
      this.nextCommandSeq();
    } else if (type === "overlayAck" && typeof action.seq === "number") {
      this.overlayAckSeq = Math.max(this.overlayAckSeq, action.seq);
    } else if (type === "layout" && isLayout(action.layout)) {
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

  private nextCommandSeq(): number {
    this.commandSeq += 1;
    this.commandIssuedAt = Date.now();
    return this.commandSeq;
  }

  private async waitForOverlayAck(seq: number): Promise<boolean> {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (this.overlayAckSeq >= seq) {
        return true;
      }
      await sleep(50);
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function postLocalToggle(): Promise<boolean> {
  return new Promise((resolve) => {
    const body = "{}";
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: BridgeServer.port,
        path: "/toggle",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        },
        timeout: 800
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.resume();
        response.on("end", () => {
          try {
            const parsed = JSON.parse(text || "{}") as { ok?: boolean };
            resolve(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300 && parsed.ok));
          } catch {
            resolve(false);
          }
        });
      }
    );
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.end(body);
  });
}

function toBridgeRecord(record: WindowRecord): Record<string, unknown> {
  return {
    windowId: record.windowId,
    title: record.alias || record.workspaceName || "Workspace",
    color: record.color ?? "#4f8cff",
    stale: record.state.stale,
    active: record.state.active,
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
