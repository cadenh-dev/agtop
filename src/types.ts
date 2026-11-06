export type HarnessType = "opencode" | "claude-code" | "aider" | "codex" | "goose" | "deepseek-harness" | "lemonade-server" | "custom";
export type Backend = "amd-lemonade-local" | "cloud-api" | "local-engine" | "unknown";
export type ContainmentMode = "linux-cgroup" | "linux-env-pgid" | "win32-job-object" | "passive-ppid";
export interface RawOsProcess {
  pid: number; ppid: number; name: string; cmdline: string; argv?: string[];
  startTime: string; cpuSeconds: number; cpuPercent: number; memoryMb: number;
  cwd?: string; pgid?: number; envTags?: Record<string, string>; cgroup?: string; state?: string;
}
export interface GitWorktreeInfo { repoRoot: string; branch: string; isWorktree: boolean; gitDir: string; commonDir: string }
export interface AgentProcessTree {
  jobId: string; harness: HarnessType; backend: Backend; backendEvidence: string;
  userOrPeer: string; rootPid: number; git?: GitWorktreeInfo; containmentMode: ContainmentMode;
  totalCpuPercent: number; totalMemoryMb: number; processes: RawOsProcess[];
}
export interface SpawnAgentOptions {
  jobId?: string; harness: HarnessType; command: string; args?: string[]; cwd?: string;
  userOrPeer?: string; useLemonadeLocal?: boolean; lemonadeUrl?: string;
  extraEnv?: Record<string, string>; stdio?: "inherit" | "ignore";
  /** A writable, delegated cgroup v2 directory. Failure is fatal when supplied. */
  cgroupRoot?: string;
}
export interface ManagedAgent {
  jobId: string; pid: number; containmentMode: ContainmentMode;
  exited: Promise<number>;
  terminate(): Promise<KillResult>;
}
export interface KillResult { killedPids: number[]; failedPids: number[]; errors: string[] }
export interface JobRecord {
  version: 1; jobId: string; rootPid: number; startTime: string; harness: HarnessType;
  peer: string; cwd: string; backend: Backend; mode: ContainmentMode;
  jobName?: string; cgroupPath?: string; createdAt: string;
}
