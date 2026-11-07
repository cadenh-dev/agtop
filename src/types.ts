export type HarnessType =
  | "claude-code" | "codex" | "opencode" | "aider" | "goose" | "deepseek-harness"
  | "gemini-cli" | "qwen-code" | "cursor-agent" | "amp" | "crush" | "cline"
  | "roo-code" | "kilo-code" | "continue-cli" | "openhands" | "swe-agent" | "plandex"
  | "mentat" | "gpt-engineer" | "open-interpreter" | "cody" | "copilot-cli"
  | "amazon-q" | "kiro" | "antigravity" | "aichat" | "shell-gpt" | "fabric"
  | "mods" | "llm" | "smolagents" | "junie" | "droid" | "kimi" | "codebuff" | "ra-aid"
  | "lemonade-server" | "ollama" | "llama-cpp" | "lm-studio" | "vllm" | "sglang"
  | "localai" | "koboldcpp" | "text-generation-webui" | "jan" | "tabby" | "tabby-agent" | "open-webui"
  | "aphrodite" | "exllamav2" | "mlc-llm" | "llama-cpp-python" | "tgi" | "triton"
  | "mistralrs" | "xinference" | "llamafile" | "mlx-lm" | "openllm"
  | "custom";
export type Backend = "amd-lemonade-local" | "cloud-api" | "local-engine" | "unknown";
export type ProcessRole =
  | "agent" | "subagent" | "mcp-server" | "inference-server" | "dev-server" | "language-server"
  | "test-runner" | "build" | "package-manager" | "git" | "browser" | "shell" | "tool";
/** Which signal produced a role. */
export type RoleSource = "job" | "harness" | "catalog" | "socket" | "inherited" | "fallback";
export interface ListeningSocket { address: string; port: number }
export interface AgentProcess extends RawOsProcess {
  role: ProcessRole;
  roleSource: RoleSource;
  /** Built only from catalog literals, PIDs, harness/job IDs and socket endpoints. Never raw argv or cwd. */
  roleEvidence: string;
}
export type ContainmentMode = "linux-cgroup" | "linux-env-pgid" | "darwin-env-pgid" | "win32-job-object" | "passive-ppid";
export interface RawOsProcess {
  pid: number; ppid: number; name: string; cmdline: string; argv?: string[];
  startTime: string; cpuSeconds: number; cpuPercent: number; memoryMb: number;
  cwd?: string; pgid?: number; envTags?: Record<string, string>; cgroup?: string; state?: string;
  accelerators?: AcceleratorUsage[];
  /** Local inference endpoint connections observed in this snapshot. */
  socketConnections?: SocketConnection[];
  /** TCP sockets this process is listening on, from the same socket snapshot as socketConnections. */
  listeningSockets?: ListeningSocket[];
}
export interface SocketConnection { address: string; port: number; serverPid?: number; serverHarness?: HarnessType }
export interface GitWorktreeInfo { repoRoot: string; branch: string; isWorktree: boolean; gitDir: string; commonDir: string }
export interface AgentProcessTree {
  jobId: string; harness: HarnessType; backend: Backend; backendEvidence: string;
  userOrPeer: string; rootPid: number; git?: GitWorktreeInfo; containmentMode: ContainmentMode;
  totalCpuPercent: number; totalMemoryMb: number; processes: AgentProcess[];
  gpuPercent?: number;
  npuPercent?: number;
  gpuMemoryMb?: number;
  /** Count of processes per role in this tree; roles with zero processes are omitted. */
  roleCounts: Partial<Record<ProcessRole, number>>;
}
export type AcceleratorKind = "gpu" | "npu";
/** One accelerator device as seen by agtop. `id` is stable for the life of the device. */
export interface AcceleratorDevice {
  id: string;
  kind: AcceleratorKind;
  name?: string;
  vendor?: string;
  utilizationPercent?: number;
}
/** Usage of one device by one process over the last sampling interval. */
export interface AcceleratorUsage {
  deviceId: string;
  kind: AcceleratorKind;
  utilizationPercent?: number;
  engine?: string;
  memoryBytes?: number;
}
export type AcceleratorSource = "windows-pdh" | "linux-drm-fdinfo" | "nvml" | "darwin-iokit" | "none";
export interface AcceleratorStatus {
  source: AcceleratorSource;
  kind: AcceleratorKind | "any";
  available: boolean;
  reason?: string;
  message?: string;
}
export interface AcceleratorSnapshot {
  devices: AcceleratorDevice[];
  status: AcceleratorStatus[];
  sampledAt: number;
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
