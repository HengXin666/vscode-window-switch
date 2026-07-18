export type WorkspaceKind = "folder" | "workspace" | "empty";
export type RemoteKind = "local" | "ssh" | "wsl" | "dev-container" | "codespaces" | "unknown";
export type OperatingSystem = "darwin" | "linux" | "unsupported";
export type LinuxSession = "x11" | "wayland" | "unknown";
export type DesktopEnvironment = "gnome" | "kde" | "sway" | "unknown";
export type TerminalActivityState = "running" | "waitingInput" | "idle";

export type WindowTerminalRecord = {
  terminalId: string;
  name: string;
  order: number;
  active?: boolean;
  state: TerminalActivityState;
  commandLine?: string;
  outputTail?: string;
  shell?: string;
  processId?: number;
  activeSince?: number;
  lastOutputAt?: number;
};

export type WindowRecord = {
  windowId: string;
  pid: number;
  titleToken: string;
  alias?: string;
  color?: string;
  tags: string[];
  workspaceKind: WorkspaceKind;
  workspaceName?: string;
  workspaceUri?: string;
  workspaceFolders: Array<{
    name: string;
    uri: string;
  }>;
  remote: {
    kind: RemoteKind;
    remoteName?: string;
    remoteAuthority?: string;
  };
  git?: {
    branch?: string;
    repoRoot?: string;
    dirty?: boolean;
  };
  terminals: WindowTerminalRecord[];
  state: {
    focused: boolean;
    active: boolean;
    stale: boolean;
    lastSeenAt: number;
    lastFocusedAt?: number;
  };
  platform: {
    os: OperatingSystem;
    linuxSession?: LinuxSession;
    desktop?: DesktopEnvironment;
  };
};

export type UserWindowConfig = {
  windowId: string;
  alias?: string;
  color?: string;
  tags?: string[];
  pinned?: boolean;
  hidden?: boolean;
};

export type WindowDeckGroup = {
  id: string;
  title: string;
  color?: string;
  collapsed?: boolean;
  windowIds: string[];
};

export type WindowDeckLayout = {
  order: string[];
  groups: WindowDeckGroup[];
};

export type RegistryData = {
  version: 1;
  windows: WindowRecord[];
  userConfigs: UserWindowConfig[];
  layout: WindowDeckLayout;
};

export type FocusResult =
  | { ok: true }
  | { ok: false; reason: string };
