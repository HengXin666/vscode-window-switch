import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

import { TerminalActivityState, WindowTerminalRecord } from "./types";

const runningQuietMs = 8000;
const processProbeTimeoutMs = 800;
const terminalProcessIdTimeoutMs = 250;
const maxCommandLineLength = 220;

type ProcessRow = {
  pid: number;
  ppid: number;
  cpuSeconds: number;
  command: string;
};

type TrackedTerminal = {
  terminal: vscode.Terminal;
  id: string;
  activeExecution?: vscode.TerminalShellExecution;
  executionSeq: number;
  commandLine?: string;
  activeSince?: number;
  lastOutputAt?: number;
  processId?: number;
  fallbackHasCommand: boolean;
  fallbackCommandLine?: string;
  fallbackLastActivityAt?: number;
  lastSampledCpuSeconds?: number;
};

export class TerminalStatusTracker implements vscode.Disposable {
  private readonly terminals = new Map<vscode.Terminal, TrackedTerminal>();
  private readonly disposables: vscode.Disposable[] = [];
  private nextId = 1;

  public constructor() {
    this.syncTerminals();
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        this.ensureTerminal(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        this.terminals.delete(terminal);
      }),
      vscode.window.onDidChangeTerminalState((terminal) => {
        this.ensureTerminal(terminal);
      }),
      vscode.window.onDidStartTerminalShellExecution((event) => {
        this.startExecution(event.terminal, event.execution);
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        this.endExecution(event.terminal, event.execution);
      })
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.terminals.clear();
  }

  public async snapshot(): Promise<WindowTerminalRecord[]> {
    const terminals = this.syncTerminals();
    await this.resolveProcessIds(terminals);
    await this.sampleProcessFallback(terminals);
    const seenAt = Date.now();
    return terminals.map((terminal, index) => {
      const tracked = this.ensureTerminal(terminal);
      return {
        terminalId: tracked.id,
        name: terminal.name,
        order: index,
        state: this.stateFor(tracked, seenAt),
        commandLine: tracked.commandLine ?? tracked.fallbackCommandLine,
        shell: terminal.state.shell,
        processId: tracked.processId,
        activeSince: tracked.activeSince,
        lastOutputAt: tracked.lastOutputAt
      };
    });
  }

  private syncTerminals(): readonly vscode.Terminal[] {
    const current = new Set(vscode.window.terminals);
    for (const terminal of current) {
      this.ensureTerminal(terminal);
    }
    for (const terminal of this.terminals.keys()) {
      if (!current.has(terminal)) {
        this.terminals.delete(terminal);
      }
    }
    return vscode.window.terminals;
  }

  private ensureTerminal(terminal: vscode.Terminal): TrackedTerminal {
    let tracked = this.terminals.get(terminal);
    if (!tracked) {
      tracked = {
        terminal,
        id: `term-${process.pid}-${this.nextId++}`,
        executionSeq: 0,
        fallbackHasCommand: false
      };
      this.terminals.set(terminal, tracked);
    }
    return tracked;
  }

  private startExecution(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): void {
    const tracked = this.ensureTerminal(terminal);
    const seenAt = Date.now();
    tracked.activeExecution = execution;
    tracked.executionSeq += 1;
    tracked.commandLine = cleanCommandLine(execution.commandLine.value);
    tracked.activeSince = seenAt;
    tracked.lastOutputAt = seenAt;
    void this.readExecutionOutput(terminal, execution, tracked.executionSeq);
  }

  private endExecution(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): void {
    const tracked = this.terminals.get(terminal);
    if (!tracked || tracked.activeExecution !== execution) {
      return;
    }
    tracked.activeExecution = undefined;
    tracked.commandLine = undefined;
    tracked.activeSince = undefined;
    tracked.lastOutputAt = undefined;
  }

  private async readExecutionOutput(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution, executionSeq: number): Promise<void> {
    try {
      for await (const chunk of execution.read()) {
        const tracked = this.terminals.get(terminal);
        if (!tracked || tracked.executionSeq !== executionSeq) {
          break;
        }
        if (chunk.length > 0) {
          tracked.lastOutputAt = Date.now();
        }
      }
    } catch {
      // Some terminals can dispose while the async stream is being read.
    }
  }

  private async resolveProcessIds(terminals: readonly vscode.Terminal[]): Promise<void> {
    await Promise.all(terminals.map(async (terminal) => {
      const tracked = this.ensureTerminal(terminal);
      try {
        tracked.processId = await withTimeout(Promise.resolve(terminal.processId), terminalProcessIdTimeoutMs);
      } catch {
        tracked.processId = undefined;
      }
    }));
  }

  private async sampleProcessFallback(terminals: readonly vscode.Terminal[]): Promise<void> {
    const roots = terminals
      .map((terminal) => this.ensureTerminal(terminal).processId)
      .filter((pid): pid is number => typeof pid === "number" && pid > 0);
    if (roots.length === 0 || (process.platform !== "linux" && process.platform !== "darwin")) {
      for (const terminal of terminals) {
        const tracked = this.ensureTerminal(terminal);
        tracked.fallbackHasCommand = false;
        tracked.fallbackCommandLine = undefined;
      }
      return;
    }

    let descendants = new Map<number, ProcessRow[]>();
    try {
      descendants = await processDescendants(roots);
    } catch {
      descendants = new Map<number, ProcessRow[]>();
    }

    const seenAt = Date.now();
    for (const terminal of terminals) {
      const tracked = this.ensureTerminal(terminal);
      const processId = tracked.processId;
      const rows = processId ? descendants.get(processId) ?? [] : [];
      const totalCpuSeconds = rows.reduce((total, row) => total + row.cpuSeconds, 0);
      const command = representativeCommand(processId, rows);
      tracked.fallbackHasCommand = rows.length > 0;
      tracked.fallbackCommandLine = command;
      if (tracked.fallbackHasCommand) {
        if (tracked.lastSampledCpuSeconds === undefined || totalCpuSeconds > tracked.lastSampledCpuSeconds) {
          tracked.fallbackLastActivityAt = seenAt;
        }
        tracked.lastSampledCpuSeconds = totalCpuSeconds;
      } else {
        tracked.fallbackLastActivityAt = undefined;
        tracked.lastSampledCpuSeconds = undefined;
      }
    }
  }

  private stateFor(tracked: TrackedTerminal, seenAt: number): TerminalActivityState {
    const hasActiveCommand = Boolean(tracked.activeExecution) || tracked.fallbackHasCommand;
    if (!hasActiveCommand) {
      return "idle";
    }
    const lastActivityAt = Math.max(tracked.lastOutputAt ?? 0, tracked.fallbackLastActivityAt ?? 0, tracked.activeSince ?? 0);
    return seenAt - lastActivityAt <= runningQuietMs ? "running" : "waitingInput";
  }
}

async function processDescendants(rootPids: number[]): Promise<Map<number, ProcessRow[]>> {
  const table = await readProcessTable();
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of table) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }

  const byRoot = new Map<number, ProcessRow[]>();
  for (const rootPid of rootPids) {
    const rows: ProcessRow[] = [];
    const stack = [...(childrenByParent.get(rootPid) ?? [])];
    const seen = new Set<number>();
    while (stack.length > 0 && seen.size < 200) {
      const row = stack.shift();
      if (!row || seen.has(row.pid)) {
        continue;
      }
      seen.add(row.pid);
      rows.push(row);
      stack.push(...(childrenByParent.get(row.pid) ?? []));
    }
    byRoot.set(rootPid, rows);
  }
  return byRoot;
}

async function readProcessTable(): Promise<ProcessRow[]> {
  const args = process.platform === "darwin"
    ? ["-axo", "pid=,ppid=,time=,command="]
    : ["-eo", "pid=,ppid=,time=,command="];
  const output = await execFile("ps", args, processProbeTimeoutMs);
  return output
    .split(/\r?\n/)
    .map(parseProcessRow)
    .filter((row): row is ProcessRow => Boolean(row));
}

function parseProcessRow(line: string): ProcessRow | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    cpuSeconds: parseCpuTime(match[3]),
    command: cleanCommandLine(match[4]) ?? ""
  };
}

function parseCpuTime(value: string): number {
  const [dayPart, timePart] = value.includes("-") ? value.split("-", 2) : ["0", value];
  const pieces = timePart.split(":").map((part) => Number(part));
  if (pieces.some((part) => !Number.isFinite(part))) {
    return 0;
  }
  const days = Number(dayPart) || 0;
  if (pieces.length === 3) {
    return days * 86400 + pieces[0] * 3600 + pieces[1] * 60 + pieces[2];
  }
  if (pieces.length === 2) {
    return days * 86400 + pieces[0] * 60 + pieces[1];
  }
  return days * 86400 + (pieces[0] ?? 0);
}

function representativeCommand(rootPid: number | undefined, rows: ProcessRow[]): string | undefined {
  if (!rootPid || rows.length === 0) {
    return undefined;
  }
  const direct = rows.filter((row) => row.ppid === rootPid);
  const nonShellDirect = direct.find((row) => !looksLikeShell(row.command));
  const nonShellAny = rows.find((row) => !looksLikeShell(row.command));
  return cleanCommandLine(nonShellDirect?.command ?? nonShellAny?.command ?? direct[0]?.command ?? rows[0]?.command);
}

function looksLikeShell(command: string): boolean {
  const executable = path.basename(command.split(/\s+/, 1)[0] ?? "");
  return /^(ba|z|fi|c|k)?sh$|^pwsh$|^powershell$|^cmd(\.exe)?$/i.test(executable);
}

function cleanCommandLine(commandLine: string | undefined): string | undefined {
  const cleaned = commandLine?.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > maxCommandLineLength ? `${cleaned.slice(0, maxCommandLineLength - 1)}...` : cleaned;
}

function execFile(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
