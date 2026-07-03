import { WindowDeckGroup, WindowDeckLayout, WindowRecord } from "./types";

export type WindowDeckItem = {
  windowId: string;
  title: string;
  color: string;
  meta: string;
  stale: boolean;
  active: boolean;
  workspaceKind: WindowRecord["workspaceKind"];
  workspaceUri?: string;
  remoteKind: WindowRecord["remote"]["kind"];
  branch?: string;
};

export function visibleWindowRecords(records: WindowRecord[]): WindowRecord[] {
  const byWorkspace = new Map<string, WindowRecord>();
  for (const record of records) {
    const key = workspaceKey(record);
    if (!key) {
      continue;
    }
    const existing = byWorkspace.get(key);
    if (!existing || rankRecord(record) > rankRecord(existing)) {
      byWorkspace.set(key, record);
    }
  }
  return [...byWorkspace.values()];
}

export function normalizeVisibleLayout(layout: WindowDeckLayout, records: WindowRecord[]): WindowDeckLayout {
  const ids = records.map((record) => record.windowId);
  const known = new Set(ids);
  const seen = new Set<string>();
  const order = (Array.isArray(layout.order) ? layout.order : []).filter((windowId) => {
    if (!known.has(windowId) || seen.has(windowId)) {
      return false;
    }
    seen.add(windowId);
    return true;
  });
  for (const windowId of ids) {
    if (!seen.has(windowId)) {
      order.push(windowId);
      seen.add(windowId);
    }
  }
  const groups = (Array.isArray(layout.groups) ? layout.groups : [])
    .map((group) => ({
      id: group.id,
      title: group.title || "分组",
      color: group.color,
      collapsed: Boolean(group.collapsed),
      windowIds: dedupe(group.windowIds).filter((windowId) => known.has(windowId))
    }))
    .filter((group) => group.windowIds.length > 0);
  return { order, groups };
}

export function orderVisibleRecords(records: WindowRecord[], layout: WindowDeckLayout): WindowRecord[] {
  const normalized = normalizeVisibleLayout(layout, records);
  const position = new Map(normalized.order.map((windowId, index) => [windowId, index]));
  return [...records].sort((a, b) => {
    if (a.state.stale !== b.state.stale) {
      return a.state.stale ? 1 : -1;
    }
    if (a.state.stale && b.state.stale && a.state.lastSeenAt !== b.state.lastSeenAt) {
      return b.state.lastSeenAt - a.state.lastSeenAt;
    }
    const aIndex = position.get(a.windowId) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = position.get(b.windowId) ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }
    return (b.state.lastFocusedAt ?? b.state.lastSeenAt) - (a.state.lastFocusedAt ?? a.state.lastSeenAt);
  });
}

export function groupIsStale(group: WindowDeckGroup, byId: Map<string, WindowRecord>): boolean {
  const records = group.windowIds.map((windowId) => byId.get(windowId)).filter((record): record is WindowRecord => Boolean(record));
  return records.length > 0 && records.every((record) => record.state.stale);
}

function workspaceKey(record: WindowRecord): string | undefined {
  if (record.workspaceKind === "empty") {
    return undefined;
  }
  return record.workspaceUri || record.workspaceFolders.map((folder) => folder.uri).join("|") || undefined;
}

function rankRecord(record: WindowRecord): number {
  const activeScore = record.state.stale ? 0 : 1_000_000_000_000_000;
  const activityTime = record.state.stale ? record.state.lastSeenAt : (record.state.lastFocusedAt ?? record.state.lastSeenAt);
  return activeScore + activityTime;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}
