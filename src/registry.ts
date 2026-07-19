import * as fs from "node:fs/promises";
import * as path from "node:path";

import { RegistryData, UserWindowConfig, WindowDeckLayout, WindowRecord } from "./types";

const emptyRegistry = (): RegistryData => ({
  version: 1,
  windows: [],
  userConfigs: [],
  layout: {
    order: [],
    groups: []
  }
});

export class Registry {
  private readonly filePath: string;
  private readonly lockPath: string;

  public constructor(directory: string) {
    this.filePath = path.join(directory, "registry.json");
    this.lockPath = path.join(directory, "registry.lock");
  }

  public async read(): Promise<RegistryData> {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      const parsed = parseRegistryJson(text);
      return {
        version: 1,
        windows: Array.isArray(parsed.windows) ? parsed.windows : [],
        userConfigs: Array.isArray(parsed.userConfigs) ? parsed.userConfigs : [],
        layout: normalizeLayout(parsed.layout)
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyRegistry();
      }
      throw error;
    }
  }

  public async update(mutator: (data: RegistryData) => RegistryData | void): Promise<RegistryData> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    return this.withLock(async () => {
      const data = await this.read();
      const next = mutator(data) ?? data;
      await this.write(next);
      return next;
    });
  }

  public async upsertWindow(record: WindowRecord): Promise<RegistryData> {
    return this.update((data) => {
      const existing = data.windows.findIndex((item) => item.windowId === record.windowId);
      if (existing >= 0) {
        data.windows[existing] = mergeConfig(record, data.userConfigs.find((item) => item.windowId === record.windowId));
      } else {
        data.windows.push(mergeConfig(record, data.userConfigs.find((item) => item.windowId === record.windowId)));
        data.layout.order.push(record.windowId);
      }
      data.layout = normalizeLayout(data.layout, data.windows.map((item) => item.windowId));
    });
  }

  public async saveUserConfig(config: UserWindowConfig): Promise<RegistryData> {
    return this.update((data) => {
      const existing = data.userConfigs.findIndex((item) => item.windowId === config.windowId);
      if (existing >= 0) {
        data.userConfigs[existing] = { ...data.userConfigs[existing], ...config };
      } else {
        data.userConfigs.push(config);
      }
      data.windows = data.windows.map((record) =>
        record.windowId === config.windowId ? mergeConfig(record, data.userConfigs.find((item) => item.windowId === config.windowId)) : record
      );
    });
  }

  public async cleanup(removeStaleAfterMs: number): Promise<number> {
    let removed = 0;
    await this.update((data) => {
      const cutoff = Date.now() - removeStaleAfterMs;
      const before = data.windows.length;
      data.windows = data.windows.filter((record) => {
        if (record.state.stale && record.workspaceKind === "empty") {
          return false;
        }
        return !record.state.stale || record.state.lastSeenAt >= cutoff;
      });
      removed = before - data.windows.length;
      data.layout = normalizeLayout(data.layout, data.windows.map((item) => item.windowId));
    });
    return removed;
  }

  public async removeWindow(windowId: string): Promise<void> {
    await this.update((data) => {
      data.windows = data.windows.filter((record) => record.windowId !== windowId);
      data.userConfigs = data.userConfigs.filter((config) => config.windowId !== windowId);
      data.layout = normalizeLayout(
        {
          order: data.layout.order.filter((item) => item !== windowId),
          groups: data.layout.groups.map((group) => ({
            ...group,
            windowIds: group.windowIds.filter((item) => item !== windowId)
          }))
        },
        data.windows.map((item) => item.windowId)
      );
    });
  }

  public async saveLayout(layout: WindowDeckLayout): Promise<void> {
    await this.update((data) => {
      data.layout = normalizeLayout(layout, data.windows.map((item) => item.windowId));
    });
  }

  private async write(data: RegistryData): Promise<void> {
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.filePath);
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const token = `${process.pid}:${Date.now()}:${Math.random()}`;
    const deadline = Date.now() + 5000;
    let acquired = false;
    while (!acquired) {
      try {
        const handle = await fs.open(this.lockPath, "wx");
        try {
          await handle.writeFile(token, "utf8");
        } finally {
          await handle.close();
        }
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.removeStaleLock();
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the Window Deck registry lock");
        await delay(20);
      }
    }
    try {
      return await action();
    } finally {
      try {
        if ((await fs.readFile(this.lockPath, "utf8")) === token) await fs.unlink(this.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Window Deck could not remove its registry lock", error);
      }
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const stat = await fs.stat(this.lockPath);
      if (Date.now() - stat.mtimeMs > 10_000) await fs.unlink(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseRegistryJson(text: string): RegistryData {
  try {
    return JSON.parse(text) as RegistryData;
  } catch (error) {
    const recovered = parseFirstJsonObject(text);
    if (recovered) {
      return recovered as RegistryData;
    }
    throw error;
  }
}

function parseFirstJsonObject(text: string): unknown | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(text.slice(start, index + 1));
      }
    }
  }
  return undefined;
}

function normalizeLayout(layout?: WindowDeckLayout, knownWindowIds: string[] = []): WindowDeckLayout {
  const known = new Set(knownWindowIds);
  const seen = new Set<string>();
  const order = (Array.isArray(layout?.order) ? layout.order : []).filter((windowId) => {
    if (seen.has(windowId) || (known.size > 0 && !known.has(windowId))) {
      return false;
    }
    seen.add(windowId);
    return true;
  });
  for (const windowId of knownWindowIds) {
    if (!seen.has(windowId)) {
      order.push(windowId);
      seen.add(windowId);
    }
  }
  const groups = (Array.isArray(layout?.groups) ? layout.groups : [])
    .map((group) => ({
      id: group.id,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
      windowIds: group.windowIds.filter((windowId) => seen.has(windowId))
    }))
    .filter((group) => group.windowIds.length > 0);
  return { order, groups };
}

function mergeConfig(record: WindowRecord, config?: UserWindowConfig): WindowRecord {
  if (!config) {
    return record;
  }
  return {
    ...record,
    alias: config.alias ?? record.alias,
    color: config.color ?? record.color,
    tags: config.tags ?? record.tags
  };
}
