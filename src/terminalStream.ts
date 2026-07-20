import type WebSocket from "ws";
import type { WebSocketServer } from "ws";

// The runtime is copied into dist/vendor so the VSIX is self-contained.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wsRuntime = require("./vendor/ws") as typeof import("ws");
const WebSocketClient = wsRuntime;
const WebSocketServerRuntime = wsRuntime.WebSocketServer;

type TerminalStreamMessage =
  | { type: "register"; windowId: string }
  | { type: "data"; windowId: string; terminalId: string; data: string }
  | { type: "input"; targetWindowId: string; terminalId: string; data: string }
  | { type: "control"; targetWindowId: string; action: "create" | "close"; terminalId?: string };

type TerminalStreamCallbacks = {
  onData(windowId: string, terminalId: string, data: string): void;
  onInput(terminalId: string, data: string): void;
  onControl(action: "create" | "close", terminalId?: string): void;
};

export class TerminalStreamHub {
  public static readonly port = 39418;
  private server?: WebSocketServer;
  private client?: WebSocket;
  private primaryWindowId?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly clients = new Map<string, WebSocket>();
  private readonly replay = new Map<string, string>();
  private readonly recentData = new Map<string, { data: string; at: number }>();
  private readonly pendingMessages: TerminalStreamMessage[] = [];
  private disposed = false;

  public constructor(private readonly windowId: string, private readonly callbacks: TerminalStreamCallbacks) {}

  public get isPrimary(): boolean {
    return this.server !== undefined;
  }

  public async start(): Promise<void> {
    this.disposed = false;
    if (this.server || this.client) return;
    const server = new WebSocketServerRuntime({ host: "127.0.0.1", port: TerminalStreamHub.port });
    try {
      await waitForListening(server);
      this.server = server;
      this.primaryWindowId = this.windowId;
      server.on("connection", (socket) => this.acceptPrimaryClient(socket));
      return;
    } catch (error) {
      server.close();
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
    this.connectToPrimary();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.client?.close();
    this.client = undefined;
    for (const socket of this.clients.values()) socket.close();
    this.clients.clear();
    this.server?.close();
    this.server = undefined;
    this.primaryWindowId = undefined;
  }

  public publishData(terminalId: string, data: string): void {
    if (!data) return;
    if (this.isDuplicateBurst(this.windowId, terminalId, data)) return;
    this.remember(this.windowId, terminalId, data);
    this.callbacks.onData(this.windowId, terminalId, data);
    const message: TerminalStreamMessage = { type: "data", windowId: this.windowId, terminalId, data };
    if (this.server) this.broadcast(message);
    else this.sendClient(message);
  }

  public getReplay(windowId: string, terminalId: string): string {
    const replay = this.replay.get(`${windowId}:${terminalId}`) ?? "";
    // Start every mounted replay from a known screen/cursor state. A replay
    // can begin in the middle of an interactive shell's line-edit buffer;
    // without this reset xterm renders stale cursor bytes as a garbage line at
    // the top of the synchronized terminal.
    return replay ? `\u001b[2J\u001b[H${replay}` : "";
  }

  public sendInput(targetWindowId: string, terminalId: string, data: string): void {
    if (!data) return;
    if (targetWindowId === this.windowId) {
      this.callbacks.onInput(terminalId, data);
      return;
    }
    const message: TerminalStreamMessage = { type: "input", targetWindowId, terminalId, data };
    if (this.server) this.sendToWindow(targetWindowId, message);
    else this.sendClient(message);
  }

  public sendControl(targetWindowId: string, action: "create" | "close", terminalId?: string): void {
    const message: TerminalStreamMessage = { type: "control", targetWindowId, action, terminalId };
    if (targetWindowId === this.windowId) {
      this.callbacks.onControl(action, terminalId);
    } else if (this.server) {
      this.sendToWindow(targetWindowId, message);
    } else {
      this.sendClient(message);
    }
  }

  private acceptPrimaryClient(socket: WebSocket): void {
    let registeredWindowId = "";
    socket.on("message", (raw) => {
      const message = parseMessage(raw.toString());
      if (!message) return;
      if (message.type === "register") {
        registeredWindowId = message.windowId;
        this.clients.set(registeredWindowId, socket);
      } else if (message.type === "data") {
        if (this.isDuplicateBurst(message.windowId, message.terminalId, message.data)) return;
        this.remember(message.windowId, message.terminalId, message.data);
        this.broadcast(message);
        this.callbacks.onData(message.windowId, message.terminalId, message.data);
      } else if (message.type === "input") {
        this.sendToWindow(message.targetWindowId, message);
      } else if (message.type === "control") {
        this.sendToWindow(message.targetWindowId, message);
      }
    });
    socket.on("close", () => {
      if (registeredWindowId && this.clients.get(registeredWindowId) === socket) this.clients.delete(registeredWindowId);
    });
  }

  private broadcast(message: TerminalStreamMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of this.clients.values()) {
      if (socket.readyState === WebSocketClient.OPEN) socket.send(payload);
    }
  }

  private sendToWindow(windowId: string, message: TerminalStreamMessage): void {
    if (windowId === this.primaryWindowId && message.type === "input") {
      this.callbacks.onInput(message.terminalId, message.data);
      return;
    }
    if (windowId === this.primaryWindowId && message.type === "control") {
      this.callbacks.onControl(message.action, message.terminalId);
      return;
    }
    const socket = this.clients.get(windowId);
    if (socket?.readyState === WebSocketClient.OPEN) socket.send(JSON.stringify(message));
  }

  private connectToPrimary(): void {
    if (this.disposed || this.client) return;
    const client = new WebSocketClient(`ws://127.0.0.1:${TerminalStreamHub.port}`);
    this.client = client;
    client.on("open", () => {
      client.send(JSON.stringify({ type: "register", windowId: this.windowId } satisfies TerminalStreamMessage));
      for (const message of this.pendingMessages.splice(0)) client.send(JSON.stringify(message));
    });
    client.on("message", (raw) => {
      const message = parseMessage(raw.toString());
      if (!message) return;
      if (message.type === "data") {
        if (this.isDuplicateBurst(message.windowId, message.terminalId, message.data)) return;
        this.remember(message.windowId, message.terminalId, message.data);
        this.callbacks.onData(message.windowId, message.terminalId, message.data);
      }
      else if (message.type === "input" && message.targetWindowId === this.windowId) this.callbacks.onInput(message.terminalId, message.data);
      else if (message.type === "control" && message.targetWindowId === this.windowId) this.callbacks.onControl(message.action, message.terminalId);
    });
    client.on("close", () => {
      this.client = undefined;
      if (!this.disposed) this.scheduleReconnect();
    });
    client.on("error", () => client.close());
  }

  private sendClient(message: TerminalStreamMessage): void {
    if (this.client?.readyState === WebSocketClient.OPEN) this.client.send(JSON.stringify(message));
    else {
      this.pendingMessages.push(message);
      this.connectToPrimary();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.server) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectToPrimary();
    }, 1000);
  }

  private remember(windowId: string, terminalId: string, data: string): void {
    const key = `${windowId}:${terminalId}`;
    let current = this.replay.get(key) ?? "";
    // A full-screen clear starts a new logical terminal screen. Discarding
    // older bytes prevents stale prompts/input from being painted above the
    // current screen when the replay is mounted in a different-sized view.
    const clearIndex = Math.max(
      data.lastIndexOf("\u001b[2J"),
      data.lastIndexOf("\u001b[1;1H\u001b[0J"),
      data.lastIndexOf("\u001b[H\u001b[2J")
    );
    if (clearIndex >= 0) current = "";
    const combined = current + data;
    if (combined.length <= 200_000) {
      this.replay.set(key, combined);
      return;
    }
    // Never begin a replay in the middle of a line/ANSI sequence. Doing so
    // makes xterm interpret a stale cursor movement as visible garbage.
    const tail = combined.slice(-200_000);
    const newline = tail.indexOf("\n");
    this.replay.set(key, newline >= 0 ? tail.slice(newline + 1) : tail);
  }

  private isDuplicateBurst(windowId: string, terminalId: string, data: string): boolean {
    // The workbench patch can report the same multi-character write twice in
    // one event-loop turn. Suppress only that burst; single keystrokes remain
    // untouched so fast repeated typing still reaches the shell.
    if (data.length <= 1) return false;
    const key = `${windowId}:${terminalId}`;
    const now = Date.now();
    const previous = this.recentData.get(key);
    this.recentData.set(key, { data, at: now });
    return Boolean(previous && previous.data === data && now - previous.at < 80);
  }
}

function waitForListening(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

function parseMessage(value: string): TerminalStreamMessage | undefined {
  try {
    const message = JSON.parse(value) as Partial<TerminalStreamMessage>;
    if (message.type === "register" && typeof message.windowId === "string") return message as TerminalStreamMessage;
    if (message.type === "data" && typeof message.windowId === "string" && typeof message.terminalId === "string" && typeof message.data === "string") return message as TerminalStreamMessage;
    if (message.type === "input" && typeof message.targetWindowId === "string" && typeof message.terminalId === "string" && typeof message.data === "string") return message as TerminalStreamMessage;
    if (message.type === "control" && typeof message.targetWindowId === "string" && (message.action === "create" || message.action === "close")) return message as TerminalStreamMessage;
  } catch {
    return undefined;
  }
  return undefined;
}
