import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

import { TerminalActivityState, WindowTerminalRecord } from "./types";

const outputQuietMs = 6000;
const processActivityQuietMs = 12000;
const promptSettledMs = 1500;
const processProbeTimeoutMs = 800;
const terminalProcessIdTimeoutMs = 250;
const maxCommandLineLength = 220;
const maxOutputTailLength = 2000;
const titleSpinnerPattern = /[\u2801-\u28ff]|[◐◓◑◒◴◷◶◵◜◠◝◞◡◟]/u;

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
  outputTail: string;
  processId?: number;
  titleHasRunningSpinner?: boolean;
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
    this.sampleTitleActivity(terminals);
    return terminals.map((terminal, index) => {
      const tracked = this.ensureTerminal(terminal);
      return {
        terminalId: tracked.id,
        name: terminal.name,
        order: index,
        active: terminal === vscode.window.activeTerminal,
        state: this.stateFor(tracked, seenAt),
        commandLine: tracked.commandLine ?? tracked.fallbackCommandLine,
        outputTail: tracked.outputTail || undefined,
        shell: terminal.state.shell,
        processId: tracked.processId,
        activeSince: tracked.activeSince,
        lastOutputAt: tracked.lastOutputAt
      };
    });
  }

  public async focusTerminal(terminalId: string): Promise<boolean> {
    const terminal = [...this.terminals.entries()].find(([, tracked]) => tracked.id === terminalId)?.[0];
    if (!terminal) {
      return false;
    }
    terminal.show(false);
    return true;
  }

  public sendText(terminalId: string, text: string, shouldExecute: boolean): boolean {
    const terminal = [...this.terminals.entries()].find(([, tracked]) => tracked.id === terminalId)?.[0];
    if (!terminal) {
      return false;
    }
    terminal.sendText(text, shouldExecute);
    return true;
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
        outputTail: "",
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
    tracked.outputTail = "";
    void this.readExecutionOutput(terminal, execution, tracked.executionSeq);
  }

  private endExecution(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): void {
    const tracked = this.terminals.get(terminal);
    if (!tracked || tracked.activeExecution !== execution) {
      return;
    }
    tracked.activeExecution = undefined;
    // Keep the last command and its captured output available to Window Deck.
    // VS Code does not expose arbitrary terminal scrollback, so this is the
    // useful preview we can retain after shell execution finishes.
  }

  private async readExecutionOutput(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution, executionSeq: number): Promise<void> {
    try {
      for await (const chunk of execution.read()) {
        const tracked = this.terminals.get(terminal);
        if (!tracked || tracked.executionSeq !== executionSeq) {
          break;
        }
        if (hasVisibleOutput(chunk)) {
          tracked.lastOutputAt = Date.now();
          tracked.outputTail = appendOutputTail(tracked.outputTail, chunk);
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

  private sampleTitleActivity(terminals: readonly vscode.Terminal[]): void {
    for (const terminal of terminals) {
      const tracked = this.ensureTerminal(terminal);
      tracked.titleHasRunningSpinner = looksLikeRunningTitle(terminal.name);
    }
  }

  private stateFor(tracked: TrackedTerminal, seenAt: number): TerminalActivityState {
    if (tracked.titleHasRunningSpinner) {
      return "running";
    }
    const hasActiveCommand = Boolean(tracked.activeExecution) || tracked.fallbackHasCommand;
    if (!hasActiveCommand) {
      return "idle";
    }
    const lastOutputAt = tracked.lastOutputAt ?? 0;
    if (lastOutputAt > 0 && looksLikeWaitingPrompt(tracked.outputTail) && seenAt - lastOutputAt >= promptSettledMs) {
      return "waitingInput";
    }
    if (lastOutputAt > 0 && seenAt - lastOutputAt <= outputQuietMs) {
      return "running";
    }
    const lastProcessActivityAt = tracked.fallbackLastActivityAt ?? 0;
    if (lastProcessActivityAt > 0 && seenAt - lastProcessActivityAt <= processActivityQuietMs) {
      return "running";
    }
    return "waitingInput";
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

function looksLikeRunningTitle(title: string): boolean {
  return titleSpinnerPattern.test(title);
}

function cleanCommandLine(commandLine: string | undefined): string | undefined {
  const cleaned = commandLine?.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > maxCommandLineLength ? `${cleaned.slice(0, maxCommandLineLength - 1)}...` : cleaned;
}

function appendOutputTail(current: string, chunk: string): string {
  const next = `${current}${stripAnsi(chunk)}`;
  return next.length > maxOutputTailLength ? next.slice(next.length - maxOutputTailLength) : next;
}

function hasVisibleOutput(chunk: string): boolean {
  let printable = "";
  for (const char of stripAnsi(chunk)) {
    const code = char.codePointAt(0) ?? 0;
    if (!isControlCode(code)) {
      printable += char;
    }
  }
  return printable.trim().length > 0;
}

function stripAnsi(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x1b) {
      output += value[index];
      continue;
    }
    index = skipEscapeSequence(value, index);
  }
  return output;
}

function skipEscapeSequence(value: string, escapeIndex: number): number {
  const introducer = value[escapeIndex + 1];
  if (!introducer) {
    return escapeIndex;
  }
  if (introducer === "[") {
    return skipUntil(value, escapeIndex + 2, isCsiFinalByte);
  }
  if (introducer === "]") {
    return skipUntilTerminator(value, escapeIndex + 2, 0x07);
  }
  if (introducer === "P" || introducer === "X" || introducer === "^" || introducer === "_") {
    return skipUntilStringTerminator(value, escapeIndex + 2);
  }
  return escapeIndex + 1;
}

function skipUntil(value: string, start: number, predicate: (code: number) => boolean): number {
  for (let index = start; index < value.length; index += 1) {
    if (predicate(value.charCodeAt(index))) {
      return index;
    }
  }
  return value.length - 1;
}

function skipUntilTerminator(value: string, start: number, terminator: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value.charCodeAt(index) === terminator) {
      return index;
    }
    if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") {
      return index + 1;
    }
  }
  return value.length - 1;
}

function skipUntilStringTerminator(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") {
      return index + 1;
    }
  }
  return value.length - 1;
}

function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function isControlCode(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

function looksLikeWaitingPrompt(outputTail: string): boolean {
  const normalized = outputTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join("\n");
  if (!normalized) {
    return false;
  }
  return [
    /(?:^|\n)(?:>|›|❯|\?)\s*$/u,
    /(?:^|\n)(?:you|user|human)\s*:\s*$/iu,
    /(?:^|\n)(?:prompt|message|input)\s*[:>]\s*$/iu,
    /(?:waiting|awaiting|ready).{0,32}(?:input|message|prompt)/iu,
    /(?:press|type).{0,32}(?:enter|return|y\/n|yes|no)/iu,
    /(?:do you want to|continue\?|proceed\?)/iu
  ].some((pattern) => pattern.test(normalized));
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
