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
