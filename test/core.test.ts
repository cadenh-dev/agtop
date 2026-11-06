import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CpuSampler, detectHarness, harnessCatalog, isLocalHarness, parseEnvironment, parseLinuxStat } from "../src/discovery.js";
import { resolveGitWorktree } from "../src/git.js";
import { backendFor } from "../src/backend.js";
import { correlateTrees } from "../src/trees.js";
import { quoteWindowsArg } from "../src/windows.js";
import type { RawOsProcess, JobRecord } from "../src/types.js";

function proc(pid: number, ppid = 0, name = "node", startTime = "1"): RawOsProcess {
  return { pid, ppid, name, cmdline: name, startTime, cpuSeconds: 0, cpuPercent: 0, memoryMb: 1 };
}
describe("process discovery", () => {
  test("parses comm containing spaces and parentheses; uses host page size and clock tick rate", () => {
    const fields = Array(22).fill("0"); fields[0] = "S"; fields[1] = "40"; fields[2] = "41";
    fields[11] = "250"; fields[12] = "50"; fields[19] = "999"; fields[21] = "32";
    const p = parseLinuxStat(`42 (worker (busy)) ${fields.join(" ")}`, 100, 65536);
    expect(p).toMatchObject({ pid: 42, ppid: 40, pgid: 41, name: "worker (busy)", cpuSeconds: 3, memoryMb: 2, startTime: "999" });
  });
  test("CPU deltas discard reused PIDs and support more than one core", () => {
    const sampler = new CpuSampler(); sampler.sample([proc(1)], 0);
    expect(sampler.sample([{ ...proc(1), cpuSeconds: 2 }], 1000)[0].cpuPercent).toBe(200);
    expect(sampler.sample([{ ...proc(1, 0, "node", "2"), cpuSeconds: 8 }], 2000)[0].cpuPercent).toBe(0);
  });
  test("environment allowlist excludes credentials", () => {
    expect(parseEnvironment("OPENAI_API_KEY=secret\0AGTOP_JOB_ID=a\0ANTHROPIC_API_KEY=secret\0OPENAI_BASE_URL=http://localhost:13305/v1\0")).toEqual({ AGTOP_JOB_ID: "a", OPENAI_BASE_URL: "http://localhost:13305/v1" });
  });
  test("recognizes entry points without matching prompt text or project names", () => {
    expect(detectHarness({ name: "node.exe", cmdline: 'node "C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js"' })).toBe("codex");
    expect(detectHarness({ name: "python", cmdline: "python -m aider" })).toBe("aider");
    expect(detectHarness({ name: "node", cmdline: 'node -e "console.log(\"claude\")"' })).toBeUndefined();
    expect(detectHarness({ name: "git", cmdline: "git commit -m codex" })).toBeUndefined();
    expect(detectHarness({ name: "node", cmdline: "node /work/codex-project/server.js" })).toBeUndefined();
  });
  test("recognizes expanded harness signatures and rejects ambiguous names", () => {
    const detect = (name: string, cmdline: string, cwd?: string) => detectHarness({ name, cmdline, cwd });
    expect(detect("node", 'node "/home/u/.npm/_npx/x/node_modules/@anthropic-ai/claude-code/cli.js"')).toBe("claude-code");
    expect(detect("node", "node /opt/node_modules/@google/gemini-cli/dist/index.js")).toBe("gemini-cli");
    expect(detect("node", "node /opt/node_modules/@qwen-code/qwen-code/dist/cli.js")).toBe("qwen-code");
    expect(detect("node", "node /opt/node_modules/@opencode/cli/index.js")).toBe("opencode");
    expect(detect("python", "python -m vllm.entrypoints.openai.api_server")).toBe("vllm");
    expect(detect("python", "python -m llama_cpp.server")).toBe("llama-cpp-python");
    expect(detect("python", "python -m sgpt")).toBe("shell-gpt");
    expect(detect("aider", "aider --model gpt")).toBe("aider");
    expect(detect("uvx", "uvx aider")).toBe("aider");
    expect(detect("npx", "npx @google/gemini-cli")).toBe("gemini-cli");
    expect(detect("cmd.exe", "cmd.exe /c codex.cmd")).toBe("codex");
    expect(detect("claude", "claude --dangerously-skip-permissions")).toBe("claude-code");
    expect(detect("claude", "C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\claude.exe")).toBeUndefined();
    expect(detect("cursor-agent", "cursor-agent -p hello")).toBe("cursor-agent");
    expect(detect("ssh-agent", "ssh-agent -s")).toBeUndefined();
    expect(detect("amp", "amp -x 'fix the tests'")).toBe("amp");
    expect(detect("goose", "goose session")).toBe("goose");
    expect(detect("goose", "goose up")).toBeUndefined();
    expect(detect("cline", "cline -p hello")).toBe("cline");
    expect(detect("gh", "gh copilot suggest 'list files'")).toBe("copilot-cli");
    expect(detect("gh", "gh status")).toBeUndefined();
    expect(detect("q", "q chat")).toBe("amazon-q");
    expect(detect("q", "q")).toBeUndefined();
    expect(detect("agy", "agy acp --process-per-session")).toBe("antigravity");
    expect(detect("ollama", "ollama serve")).toBe("ollama");
    expect(detect("llama-server", "llama-server --model x.gguf")).toBe("llama-cpp");
    expect(detect("server", "server --model x.gguf")).toBeUndefined();
    expect(detect("llmster", "llmster")).toBe("lm-studio");
    expect(detect("tabby", "tabby serve --port 8080")).toBe("tabby");
    expect(detect("tabby", "tabby")).toBeUndefined();
    expect(detect("python", "python server.py", "/work/text-generation-webui")).toBe("text-generation-webui");
    expect(detect("python", "python server.py", "/work/unrelated")).toBeUndefined();
    expect(detect("node", "node /work/codex-project/server.js")).toBeUndefined();
    expect(detect("node", "node -e \"console.log('claude')\"")).toBeUndefined();
    expect(detect("git", 'git commit -m "/home/u/node_modules/@openai/codex/file"')).toBeUndefined();
    expect(detect("gh", "gh issue create --title copilot")).toBeUndefined();
    expect(detect("goose", "goose --help")).toBeUndefined();
  });
  test("harness catalog exposes agents, servers, and the custom command", () => {
    const catalog = harnessCatalog();
    expect(catalog.some(h => h.id === "claude-code" && h.kind === "agent")).toBe(true);
    expect(catalog.some(h => h.id === "ollama" && h.kind === "server")).toBe(true);
    expect(catalog.some(h => h.id === "custom")).toBe(true);
    expect(new Set(catalog.map(h => h.id)).size).toBe(catalog.length);
    expect(isLocalHarness("ollama")).toBe(true);
    expect(isLocalHarness("claude-code")).toBe(false);
  });
  test("sorts roots before children and assigns each PID once", () => {
    const trees = correlateTrees([proc(30, 20, "codex"), proc(10, 0, "claude"), proc(20, 10)], []);
    expect(trees).toHaveLength(1); expect(trees[0].rootPid).toBe(10);
    expect(trees[0].processes.map(p => p.pid)).toEqual([10, 20, 30]);
  });
  test("passive ancestors cannot steal managed members", () => {
    const record = { jobId: "owned", rootPid: 20, harness: "custom", mode: "win32-job-object", backend: "unknown", cwd: os.tmpdir() } as JobRecord;
    const trees = correlateTrees([proc(10, 0, "codex"), proc(20, 10), proc(30, 20)], [record], new Map([["owned", [20, 30]]]));
    expect(trees.map(t => t.processes.length).sort()).toEqual([1, 2]);
  });
  test("does not follow a reused parent PID", () => {
    const trees = correlateTrees([proc(10, 0, "codex", "20"), proc(20, 10, "node", "10")], []);
    expect(trees[0].processes).toHaveLength(1);
  });
  test("tags alone do not claim kernel containment", () => {
    const trees = correlateTrees([{ ...proc(10), envTags: { AGTOP_JOB_ID: "tagged" } }], []);
    expect(trees[0].containmentMode).toBe("passive-ppid");
  });
});
test("Git worktrees, detached HEAD, submodules and nested directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-git-"));
  try {
    fs.mkdirSync(path.join(root, ".git")); fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/feature/agents\n");
    expect(resolveGitWorktree(path.join(root, "src"))).toMatchObject({ repoRoot: root, branch: "feature/agents", isWorktree: false });
    const wt = path.join(root, "linked"), admin = path.join(root, ".git", "worktrees", "linked");
    fs.mkdirSync(wt); fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../.git/worktrees/linked\n");
    fs.writeFileSync(path.join(admin, "HEAD"), "0123456789abcdef\n"); fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
    expect(resolveGitWorktree(wt)).toMatchObject({ branch: "01234567", isWorktree: true });
    fs.rmSync(path.join(admin, "commondir"));
    expect(resolveGitWorktree(wt)?.isWorktree).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("backend evidence requires exact local host and port", () => {
  const p = (url: string) => [{ ...proc(1), envTags: { OPENAI_BASE_URL: url } }];
  expect(backendFor(p("http://127.0.0.1:13305/v1")).backend).toBe("amd-lemonade-local");
  expect(backendFor(p("https://example.com:13305")).backend).toBe("unknown");
  expect(backendFor(p("https://localhost.evil.test:13305")).backend).toBe("unknown");
  expect(backendFor(p("https://api.openai.com/v1")).backend).toBe("cloud-api");
  expect(backendFor([], true).backend).toBe("local-engine");
  expect(backendFor([{ ...proc(1), envTags: { AGTOP_BACKEND: "amd-lemonade-local" } }], true).backend).toBe("amd-lemonade-local");
  expect(backendFor([]).backend).toBe("unknown");
});
test("Win32 quoting preserves empty arguments, quotes, and trailing slashes", () => {
  expect(quoteWindowsArg("")).toBe('""');
  expect(quoteWindowsArg("plain")).toBe("plain");
  expect(quoteWindowsArg('a"b')).toBe('"a\\"b"');
  expect(quoteWindowsArg("C:\\a b\\")).toBe('"C:\\a b\\\\"');
});
