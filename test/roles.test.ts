import { describe, expect, test } from "bun:test";
import { correlateTrees } from "../src/trees.js";
import { HARNESS_DEFINITIONS } from "../src/harnesses.js";
import type { HarnessType, ProcessRole, RawOsProcess, RoleSource } from "../src/types.js";
import {
  PRE_HARNESS_ROLES, ROLE_DEFINITIONS, ROLE_INFO, ROLE_ORDER, analyzeCommand, classifyTreeRoles, countRoles,
  matchRoleRule, roleCatalog,
} from "../src/roles.js";

const SECRET = "S3CRET-TOKEN-123";
function proc(pid: number, ppid: number, argv: string[], extra: Partial<RawOsProcess> = {}): RawOsProcess {
  const executable = argv[0] || "unknown";
  return {
    pid, ppid, name: extra.name ?? executable.replace(/\\/g, "/").split("/").pop() ?? "unknown", argv,
    cmdline: argv.join(" "), startTime: String(pid), cpuSeconds: 0, cpuPercent: 0, memoryMb: 0, ...extra,
  };
}
interface Fixture { tree: Parameters<typeof classifyTreeRoles>[0]; pid: number }
interface Options {
  harness?: HarnessType; jobId?: string; managed?: boolean; tagId?: string; rootPid?: number; targetPid?: number;
  ppid?: number; parents?: RawOsProcess[]; extras?: RawOsProcess[]; targetExtra?: Partial<RawOsProcess>;
}
function makeFixture(argv: string[], options: Options = {}): Fixture {
  const parents = options.parents ?? [proc(1, 0, ["claude"]), proc(2, 1, ["bash"])];
  const pid = options.targetPid ?? 3;
  const target = proc(pid, options.ppid ?? parents.at(-1)?.pid ?? 0, argv, options.targetExtra);
  return { tree: { jobId: options.jobId ?? "test-job", harness: options.harness ?? "claude-code",
    rootPid: options.rootPid ?? parents[0]?.pid ?? pid, tagId: options.tagId, managed: options.managed ?? false,
    processes: [...parents, ...(options.extras ?? []), target] }, pid };
}
function cloneFixture(input: Fixture): Fixture {
  return {
    pid: input.pid,
    tree: {
      ...input.tree,
      processes: input.tree.processes.map(process => ({
        ...process,
        argv: process.argv ? [...process.argv] : undefined,
        envTags: process.envTags ? { ...process.envTags } : undefined,
        listeningSockets: process.listeningSockets?.map(socket => ({ ...socket })),
      })),
    },
  };
}
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
type Case = { name: string; fixture: Fixture; role: ProcessRole; source: RoleSource; evidence: RegExp };
function row(name: string, argv: string[], role: ProcessRole, source: RoleSource, evidence: RegExp, options: Options = {}): Case {
  return { name, fixture: makeFixture(argv, options), role, source, evidence };
}

// Each P row in §2.11 is represented. Grouped rows have one case per listed command.
const positive: Case[] = [
  row("P1 MCP package path", ["node", "/h/.npm/_npx/a/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "/w"], "mcp-server", "catalog", /mcp-servers: path @modelcontextprotocol\/server-/),
  row("P2 npx MCP", ["npx", "-y", "@modelcontextprotocol/server-github"], "mcp-server", "catalog", /mcp-servers: path @modelcontextprotocol\/server-/),
  row("P3 uvx MCP", ["uvx", "mcp-server-git", "--repository", "/w"], "mcp-server", "catalog", /binary prefix mcp-server-/),
  row("P4 Python MCP module", ["python3", "-m", "mcp_server_fetch"], "mcp-server", "catalog", /module prefix mcp_server_/),
  row("P5 Playwright MCP package", ["npx", "@playwright/mcp@latest"], "mcp-server", "catalog", /path @playwright\/mcp/),
  row("P6 MCP suffix binary", ["chrome-devtools-mcp", "--headless"], "mcp-server", "catalog", /binary suffix -mcp/),
  row("P7 Codex MCP mode", ["codex", "mcp-server"], "mcp-server", "catalog", /agent-mcp-mode: binary codex \+ args "mcp-server"/),
  row("P8 Claude MCP mode", ["claude", "mcp", "serve"], "mcp-server", "catalog", /agent-mcp-mode: binary claude/),
  row("P9 Claude Code package MCP mode", ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "mcp", "serve"], "mcp-server", "catalog", /agent-mcp-mode: path @anthropic-ai\/claude-code/),
  row("P10 agtop MCP mode", ["agtop", "mcp"], "mcp-server", "catalog", /agent-mcp-mode: binary agtop/),
  row("P10 Goose MCP mode", ["goose", "mcp", "developer"], "mcp-server", "catalog", /agent-mcp-mode: binary goose/),
  row("P11 Codex subagent", ["codex", "exec", "fix tests"], "subagent", "harness", /nested harness codex/),
  row("P12 Copilot subagent", ["gh", "copilot", "suggest", "x"], "subagent", "harness", /nested harness copilot-cli/),
  row("P13 same-harness launcher", ["/h/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex"], "agent", "harness", /launcher chain: harness codex under pid 1/, {
    harness: "codex", parents: [proc(1, 0, ["node", "/h/node_modules/@openai/codex/bin/codex.js"])],
  }),
  row("P14 orphaned launcher", ["codex"], "agent", "harness", /recorded root pid 10 not running/, { harness: "codex", rootPid: 10, ppid: 10 }),
  row("P15 Ollama runner", ["ollama", "runner", "--model", "/m"], "inference-server", "harness", /harness ollama/, {
    harness: "ollama", parents: [proc(1, 0, ["ollama", "serve"])],
  }),
  row("P16 TypeScript language server", ["typescript-language-server", "--stdio"], "language-server", "catalog", /binary suffix -language-server/),
  row("P16 tsserver entry point", ["node", "/w/node_modules/typescript/lib/tsserver.js"], "language-server", "catalog", /binary tsserver/),
  row("P16 rust-analyzer", ["rust-analyzer"], "language-server", "catalog", /binary rust-analyzer/),
  row("P16 gopls", ["gopls"], "language-server", "catalog", /binary gopls/),
  row("P16 Ruff server", ["ruff", "server"], "language-server", "catalog", /binary ruff \+ args "server"/),
  row("P16 Deno LSP", ["deno", "lsp"], "language-server", "catalog", /binary deno \+ args "lsp"/),
  row("P16 pylsp module", ["python", "-m", "pylsp"], "language-server", "catalog", /module pylsp/),
  row("P17 Vitest", ["vitest", "run"], "test-runner", "catalog", /binary vitest/),
  row("P17 npx Vitest", ["npx", "vitest"], "test-runner", "catalog", /binary vitest/),
  row("P17 Jest watch", ["jest", "--watch"], "test-runner", "catalog", /binary jest/),
  row("P17 Pytest module", ["python", "-m", "pytest", "-x", "tests/"], "test-runner", "catalog", /module pytest/),
  row("P17 Jest worker path", ["node", "/w/node_modules/jest-worker/build/workers/processChild.js"], "test-runner", "catalog", /path \/jest-worker\//),
  row("P17 Bun test", ["bun", "test"], "test-runner", "catalog", /binary bun \+ args "test"/),
  row("P17 Cargo test", ["cargo", "test"], "test-runner", "catalog", /binary cargo \+ args "test"/),
  row("P17 Go test", ["go", "test", "\.\/\.\.\."], "test-runner", "catalog", /binary go \+ args "test"/),
  row("P17 Maven test", ["mvn", "test"], "test-runner", "catalog", /binary mvn \+ args "test"/),
  row("P18 Vite build", ["vite", "build"], "build", "catalog", /build-subcommands: binary vite \+ args "build"/),
  row("P18 Next build", ["next", "build"], "build", "catalog", /build-subcommands: binary next \+ args "build"/),
  row("P18 Cargo build", ["cargo", "build"], "build", "catalog", /build-subcommands: binary cargo \+ args "build"/),
  row("P18 Go build", ["go", "build", "\.\/\.\.\."], "build", "catalog", /build-subcommands: binary go \+ args "build"/),
  row("P18 tsc", ["tsc", "--watch"], "build", "catalog", /build-tools: binary tsc/),
  row("P18 Webpack", ["webpack", "--mode", "production"], "build", "catalog", /build-tools: binary webpack/),
  row("P18 make", ["make", "-j8"], "build", "catalog", /build-tools: binary make/),
  row("P18 cc1plus", ["cc1plus"], "build", "catalog", /build-tools: binary cc1plus/),
  row("P18 Bun build", ["bun", "build", "./x.ts"], "build", "catalog", /build-subcommands: binary bun \+ args "build"/),
  row("P19 Vite", ["vite"], "dev-server", "catalog", /dev-servers: binary vite/),
  row("P19 Vite entry point", ["node", "/w/node_modules/vite/bin/vite.js"], "dev-server", "catalog", /dev-servers: binary vite/),
  row("P19 Next dev", ["next", "dev"], "dev-server", "catalog", /binary next \+ args "dev"/),
  row("P19 Webpack serve", ["webpack", "serve"], "dev-server", "catalog", /binary webpack \+ args "serve"/),
  row("P19 Django runserver", ["python", "manage.py", "runserver"], "dev-server", "catalog", /binary manage \+ args "runserver"/),
  row("P19 Uvicorn", ["uvicorn", "app:app", "--reload"], "dev-server", "catalog", /binary uvicorn/),
  row("P19 Python HTTP module", ["python", "-m", "http.server", "8000"], "dev-server", "catalog", /module http.server/),
  row("P19 env with Vite", ["env", "NODE_ENV=development", "vite", "--port", "3000"], "dev-server", "catalog", /binary vite/),
  row("P19 Flask module", ["python", "-m", "flask", "run"], "dev-server", "catalog", /module flask \+ args "run"/),
  row("P20 Playwright browser path", ["/h/.cache/ms-playwright/chromium-1140/chrome-linux/chrome", "--headless=new"], "browser", "catalog", /browsers: binary chrome/),
  row("P20 Chrome helper name", ["Google Chrome Helper (Renderer)"], "browser", "catalog", /binary prefix google chrome/, { targetExtra: { name: "Google Chrome Helper (Renderer)" } }),
  row("P20 ChromeDriver", ["chromedriver"], "browser", "catalog", /binary chromedriver/),
  row("P21 Git status", ["git", "status"], "git", "catalog", /binary git/),
  row("P21 Git remote helper", ["git-remote-https", "origin", "https://x"], "git", "catalog", /binary prefix git-/),
  row("P21 gh pull request", ["gh", "pr", "create"], "git", "catalog", /binary gh/),
  row("P22 npm script", ["npm", "run", "dev"], "package-manager", "catalog", /binary npm/),
  row("P22 npm CLI entry point", ["node", "/usr/lib/node_modules/npm/bin/npm-cli.js", "run", "dev"], "package-manager", "catalog", /binary npm-cli/),
  row("P22 pnpm install", ["pnpm", "install"], "package-manager", "catalog", /binary pnpm/),
  row("P22 pip install", ["pip", "install", "x"], "package-manager", "catalog", /binary pip/),
  row("P22 Python pip entry point", ["/usr/bin/python3", "/usr/bin/pip", "install", "x"], "package-manager", "catalog", /binary pip/),
  row("P22 Cargo install", ["cargo", "install", "rg"], "package-manager", "catalog", /binary cargo \+ args "install"/),
  row("P22 Bun install", ["bun", "install"], "package-manager", "catalog", /binary bun \+ args "install"/),
  row("P22 uv pip", ["uv", "pip", "install", "x"], "package-manager", "catalog", /package-managers: binary pip/),
  row("P23 bash -c", ["bash", "-c", "npm run dev"], "shell", "catalog", /shells: binary bash/),
  row("P23 cmd /c", ["cmd.exe", "/c", "npm test"], "shell", "catalog", /shells: binary cmd/),
  row("P23 login zsh", ["-zsh"], "shell", "catalog", /shells: binary -zsh/),
  row("P23 PowerShell", ["pwsh", "-File", "x.ps1"], "shell", "catalog", /shells: binary pwsh/),
  row("P24 listener under npm", ["node", "server.js"], "dev-server", "socket", /socket: listening 127\.0\.0\.1:3000/, {
    parents: [proc(1, 0, ["claude"]), proc(2, 1, ["bash"]), proc(4, 2, ["npm", "run", "dev"])], ppid: 4,
    targetExtra: { listeningSockets: [{ address: "127.0.0.1", port: 3000 }] },
  }),
  row("P25 fixture under Jest", ["node", "-e", "work()"], "test-runner", "inherited", /inherited from pid 4 \(test-runner\)/, {
    parents: [proc(1, 0, ["claude"]), proc(2, 1, ["bash"]), proc(4, 2, ["jest"])], ppid: 4,
  }),
  row("P26 listening fixture under Jest", ["node", "fixture.js"], "test-runner", "inherited", /inherited from pid 4 \(test-runner\)/, {
    parents: [proc(1, 0, ["claude"]), proc(2, 1, ["bash"]), proc(4, 2, ["jest"])], ppid: 4,
    targetExtra: { listeningSockets: [{ address: "127.0.0.1", port: 4567 }] },
  }),
  row("P27 custom npm root", ["npm", "run", "dev"], "package-manager", "catalog", /package-managers: binary npm/, { harness: "custom", parents: [], targetPid: 7 }),
  row("P28 custom root fallback", ["bun", "-e", "setInterval(()=>{},1000)"], "agent", "job", /root of job test-job \(custom command\)/, { harness: "custom", parents: [], targetPid: 7 }),
  row("P29 foreign job tag", ["node", "worker.js"], "subagent", "job", /nested job inner \(codex\)/, {
    tagId: "outer", targetExtra: { envTags: { AGTOP_JOB_ID: "inner", AGTOP_HARNESS: "codex" } },
  }),
  row("foreign nested server job tag", ["node", "worker.js"], "inference-server", "job", /nested job inner \(ollama\)/, {
    tagId: "outer", targetExtra: { envTags: { AGTOP_JOB_ID: "inner", AGTOP_HARNESS: "ollama" } },
  }),
  row("P30 child inherits Next dev role", ["node", "/w/node_modules/next/dist/server/lib/start-server.js"], "dev-server", "inherited", /inherited from pid 4 \(dev-server\)/, {
    parents: [proc(1, 0, ["claude"]), proc(2, 1, ["bash"]), proc(4, 2, ["next", "dev"])], ppid: 4,
  }),
  row("unknown command uses tool fallback", ["mystery-command", "--version"], "tool", "fallback", /no matching rule/),
];

// Every F row is covered; F9 has four distinct command fixtures and F15 has three.
const falsePositive: Case[] = [
  row("F1 git commit prompt", ["git", "commit", "-m", "start the vite dev server"], "git", "catalog", /binary git/),
  row("F2 inline code mentioning vite", ["node", "-e", "require('vite')"], "tool", "fallback", /no matching rule/),
  row("F3 inline code mentioning MCP package", ["node", "-e", "require('/x/node_modules/@modelcontextprotocol/server-x')"], "tool", "fallback", /no matching rule/),
  row("F4 Claude prompt text", ["claude", "-p", "run pytest and fix mcp-server-git"], "subagent", "harness", /nested harness claude-code/),
  row("F5 MCP token after Codex exec", ["codex", "exec", "mcp-server"], "subagent", "harness", /nested harness codex/),
  row("F6 MCP in project path", ["node", "/work/my-mcp-server-project/index.js"], "tool", "fallback", /no matching rule/),
  row("F7 Vite only in cwd", ["bash"], "shell", "catalog", /shells: binary bash/, { targetExtra: { cwd: "/work/vite" } }),
  row("F8 text-generation-webui only in cwd", ["python", "server.py"], "tool", "fallback", /no matching rule/, { targetExtra: { cwd: "/work/text-generation-webui" } }),
  row("F9 cat Vite config", ["cat", "vite.config.ts"], "tool", "fallback", /no matching rule/),
  row("F9 grep tsserver", ["grep", "-r", "tsserver", "."], "tool", "fallback", /no matching rule/),
  row("F9 Go version", ["go", "version"], "tool", "fallback", /no matching rule/),
  row("F9 Ruff check", ["ruff", "check", "."], "tool", "fallback", /no matching rule/),
  row("F10 MCP only as flag", ["python", "script.py", "--mcp-server"], "tool", "fallback", /no matching rule/),
  row("F11 ssh-agent", ["ssh-agent", "-s"], "tool", "fallback", /no matching rule/),
  row("F12 mcp-inspector", ["mcp-inspector"], "tool", "fallback", /no matching rule/),
  row("F13 Docker MCP image", ["docker", "run", "-i", "--rm", "mcp/github"], "tool", "fallback", /no matching rule/),
  row("F14 Bun run without socket", ["bun", "run", "server.ts"], "tool", "fallback", /no matching rule/),
  row("F15 Tabby terminal", ["tabby"], "tool", "fallback", /no matching rule/),
  row("F15 Goose unrelated subcommand", ["goose", "up"], "tool", "fallback", /no matching rule/),
  row("F15 generic server", ["server", "--model", "x.gguf"], "tool", "fallback", /no matching rule/),
  row("F16 inline Bun code", ["bun", "-e", "test"], "tool", "fallback", /no matching rule/),
  row("F17 unknown Node under shell", ["node", "app.js"], "tool", "fallback", /no matching rule/),
  row("F18 unknown Node under npm", ["node", "app.js"], "tool", "fallback", /no matching rule/, {
    parents: [proc(1, 0, ["claude"]), proc(2, 1, ["bash"]), proc(4, 2, ["npm", "run", "dev"])], ppid: 4,
  }),
  // Role-specific near misses keep the catalog narrow for the remaining roles too.
  row("Claude child is not a second agent root", ["claude", "-p", "plain answer"], "subagent", "harness", /nested harness claude-code/),
  row("Codex mentioned as a cat argument", ["cat", "codex"], "tool", "fallback", /no matching rule/),
  row("MCP name mentioned as echo text", ["echo", "mcp-server-fetch"], "tool", "fallback", /no matching rule/),
  row("Pytest mentioned in a Git commit", ["git", "commit", "-m", "pytest"], "git", "catalog", /version-control: binary git/),
  row("Build tool mentioned as a filename", ["cat", "makefile"], "tool", "fallback", /no matching rule/),
  row("npm mentioned as echo text", ["echo", "npm install"], "tool", "fallback", /no matching rule/),
  row("Git mentioned as echo text", ["echo", "git status"], "tool", "fallback", /no matching rule/),
  row("Browser name mentioned as a filename", ["cat", "chrome"], "tool", "fallback", /no matching rule/),
  row("Shell name mentioned as a filename", ["cat", "bashrc"], "tool", "fallback", /no matching rule/),
];

describe("role classifier cases", () => {
  test("covers every planned positive and false-positive example", () => {
    expect(positive).toHaveLength(77);
    expect(falsePositive).toHaveLength(32);
  });
  test.each(positive)("$name", ({ fixture: input, role, source, evidence }) => {
    const assignment = classifyTreeRoles(input.tree).get(input.pid);
    expect(assignment?.role).toBe(role);
    expect(assignment?.source).toBe(source);
    expect(assignment?.evidence).toMatch(evidence);
  });
  test.each(falsePositive)("$name", ({ fixture: input, role, source, evidence }) => {
    const assignment = classifyTreeRoles(input.tree).get(input.pid);
    expect(assignment?.role).toBe(role);
    expect(assignment?.source).toBe(source);
    expect(assignment?.evidence).toMatch(evidence);
  });
  test("evidence across positive fixtures never contains raw argv, cwd, or environment text", () => {
    for (const item of positive) {
      const { tree, pid } = cloneFixture(item.fixture);
      const target = tree.processes.find(process => process.pid === pid)!;
      target.argv = [...(target.argv ?? []), SECRET];
      target.cmdline = `${target.cmdline} ${SECRET}`;
      target.cwd = `/work/${SECRET}`;
      target.envTags = { ...target.envTags, OPENAI_API_BASE: `https://${SECRET}` };
      for (const assignment of classifyTreeRoles(tree).values()) expect(assignment.evidence).not.toContain(SECRET);
    }
  });
  test("classification never reads cwd", () => {
    const input = makeFixture(["node", "app.js"]);
    Object.defineProperty(input.tree.processes.at(-1), "cwd", { get() { throw new Error("cwd read"); } });
    expect(() => classifyTreeRoles(input.tree)).not.toThrow();
  });
});

describe("role precedence", () => {
  const cases: Array<[string, string[], ProcessRole]> = [
    ["vite", ["vite"], "dev-server"], ["vite build", ["vite", "build"], "build"],
    ["webpack", ["webpack"], "build"], ["webpack serve", ["webpack", "serve"], "dev-server"],
    ["mvn", ["mvn"], "build"], ["mvn test", ["mvn", "test"], "test-runner"],
    ["codex", ["codex"], "subagent"], ["codex mcp-server", ["codex", "mcp-server"], "mcp-server"],
    ["gh", ["gh"], "git"], ["gh copilot", ["gh", "copilot"], "subagent"],
  ];
  test("covers all five precedence pairs", () => expect(cases).toHaveLength(10));
  test.each(cases)("%s", (_label, argv, role) => {
    const input = makeFixture(argv);
    expect(classifyTreeRoles(input.tree).get(input.pid)?.role).toBe(role);
  });
});

describe("catalog and structural invariants", () => {
  test("catalog IDs, rules, literals, and args are valid", () => {
    const ids = ROLE_DEFINITIONS.map(definition => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of ROLE_DEFINITIONS) {
      expect(definition.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(definition.rules.length).toBeGreaterThan(0);
      for (const rule of definition.rules) {
        const entries = Object.entries(rule).filter(([, value]) => value !== undefined) as Array<[string, string[]]>;
        expect(entries.length).toBeGreaterThan(0);
        for (const [, literals] of entries) for (const literal of literals) {
          expect(literal).toBe(literal.toLowerCase());
          expect(literal).not.toContain("\\");
        }
        for (const sequence of rule.args ?? []) for (const part of sequence.split(" ")) expect(part.startsWith("-")).toBe(false);
      }
    }
    for (const role of ROLE_ORDER.filter(role => !["agent", "subagent", "tool", "inference-server"].includes(role))) {
      expect(ROLE_DEFINITIONS.some(definition => definition.role === role)).toBe(true);
    }
    expect(ROLE_DEFINITIONS.some(definition => definition.role === "inference-server")).toBe(false);
    expect([...PRE_HARNESS_ROLES]).toEqual(["mcp-server"]);
  });
  test("catalog metadata uses the declared order", () => {
    const catalog = roleCatalog();
    expect(catalog.map(item => item.role)).toEqual([...ROLE_ORDER]);
    expect(catalog).toHaveLength(13);
    for (const role of ROLE_ORDER) {
      expect(ROLE_INFO[role].label.length).toBeGreaterThan(0);
      expect(ROLE_INFO[role].description.length).toBeGreaterThan(0);
    }
    expect(catalog.find(item => item.role === "inference-server")?.definitions).toEqual([]);
  });
  test("rule matching checks suffix length, exclusions, modules, and args", () => {
    expect(matchRoleRule({ binarySuffixes: ["-mcp"] }, { anchors: [{ name: "-mcp", path: "-mcp", rest: [] }] })).toBeUndefined();
    expect(matchRoleRule({ binaries: ["git"], excludePaths: ["/fake/"] }, { anchors: [{ name: "git", path: "/fake/git", rest: [] }] })).toBeUndefined();
    expect(matchRoleRule({ modules: ["django"], args: ["runserver"] }, { anchors: [], module: { name: "django.core", rest: ["runserver"] } }))
      .toBe('module django + args "runserver"');
    expect(matchRoleRule({ binaries: ["git"], args: ["status"] }, { anchors: [{ name: "git", path: "git", rest: ["commit", SECRET] }] })).toBeUndefined();
  });
  test("roles and counts follow the public order and omit zeros", () => {
    expect(roleCatalog().map(item => item.role)).toEqual([...ROLE_ORDER]);
    const counts = countRoles([{ role: "agent" }, { role: "tool" }, { role: "tool" }]);
    expect(counts).toEqual({ agent: 1, tool: 2 });
    expect(Object.values(counts).reduce((sum, count) => sum + count!, 0)).toBe(3);
  });
});

describe("role classifier structure and cost", () => {
  test("input order does not affect assignments across seeded shuffles and a cycle", () => {
    const input = makeFixture(["vite", "build"]);
    const cycle = {
      jobId: "cycle", harness: "custom" as const, rootPid: 99, managed: false,
      processes: [proc(1, 2, ["unknown-a"]), proc(2, 1, ["unknown-b"]), proc(3, 2, ["unknown-c"])],
    };
    for (const tree of [input.tree, cycle]) {
      const baseline = [...classifyTreeRoles(tree)].sort(([a], [b]) => a - b);
      for (const seed of [1, 17, 2025, 0x5eed]) {
        const shuffled = { ...tree, processes: seededShuffle(tree.processes, seed) };
        expect([...classifyTreeRoles(shuffled)].sort(([a], [b]) => a - b)).toEqual(baseline);
      }
    }
  });
  test("10,000-deep and 10,000-wide inputs classify within a stable budget", () => {
    const chain: RawOsProcess[] = [proc(1, 0, ["claude"])];
    for (let pid = 2; pid <= 10_000; pid++) chain.push(proc(pid, pid - 1, ["unknown-worker"]));
    const deep = { jobId: "deep", harness: "claude-code" as const, rootPid: 1, managed: false, processes: chain };

    const wideProcesses: RawOsProcess[] = [proc(1, 0, ["claude"])];
    for (let pid = 2; pid <= 10_000; pid++) wideProcesses.push(proc(pid, 1, ["unknown-worker"]));
    const wide = { jobId: "wide", harness: "claude-code" as const, rootPid: 1, managed: false, processes: wideProcesses };

    const budgetMs = process.env.CI ? 1_000 : 400;
    for (const [tree, expectedCounts] of [
      [deep, { agent: 1, tool: 9_999 }],
      [wide, { agent: 1, tool: 9_999 }],
    ] as const) {
      let bestMs = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        const assignments = classifyTreeRoles(tree);
        bestMs = Math.min(bestMs, performance.now() - start);
        expect(assignments.size).toBe(10_000);
        expect(countRoles([...assignments.values()])).toEqual(expectedCounts);
      }
      expect(bestMs).toBeLessThan(budgetMs);
    }
  });
  test("cycles in ppid relationships terminate", () => {
    const tree = { jobId: "cycle", harness: "custom" as const, rootPid: 99, managed: false,
      processes: [proc(1, 2, ["unknown-a"]), proc(2, 1, ["unknown-b"]) ] };
    const assignments = classifyTreeRoles(tree);
    expect(assignments.size).toBe(2);
    expect(countRoles([...assignments.values()])).toEqual({ tool: 2 });
  });
  test("inheritance propagates to descendants and sockets use the lowest port", () => {
    const inherited = makeFixture(["node", "-e", "work()"], {
      parents: [proc(1, 0, ["claude"]), proc(2, 1, ["bash"]), proc(4, 2, ["jest"]), proc(5, 4, ["unknown-worker"])],
      ppid: 5,
    });
    expect(classifyTreeRoles(inherited.tree).get(inherited.pid)).toEqual({
      role: "test-runner", source: "inherited", evidence: "inherited from pid 5 (test-runner)",
    });

    const listener = makeFixture(["unknown-server"], { targetExtra: { listeningSockets: [
      { address: "127.0.0.1", port: 5000 }, { address: "::1", port: 3000 },
    ] } });
    expect(classifyTreeRoles(listener.tree).get(listener.pid)).toEqual({
      role: "dev-server", source: "socket", evidence: "socket: listening ::1:3000",
    });
  });
});

describe("correlateTrees role integration", () => {
  test("passive Claude tree classifies agent, shell, dev server, and inference server", () => {
    const raw = [proc(100, 0, ["claude"]), proc(101, 100, ["bash"]), proc(102, 101, ["vite"]), proc(103, 102, ["ollama", "serve"])];
    const tree = correlateTrees(raw, []).find(item => item.rootPid === 100)!;
    expect(tree.processes.map(item => item.role)).toEqual(["agent", "shell", "dev-server", "inference-server"]);
    expect(tree.processes.every(item => !!item.role && !!item.roleSource && !!item.roleEvidence)).toBe(true);
    expect(Object.values(tree.roleCounts).reduce((sum, count) => sum + count!, 0)).toBe(tree.processes.length);
    expect(tree.roleCounts).toEqual({ agent: 1, shell: 1, "dev-server": 1, "inference-server": 1 });
  });
  test("every correlated process has role fields and counts sum to tree size", () => {
    const trees = correlateTrees([proc(20, 0, ["claude"]), proc(21, 20, ["bash"]), proc(22, 21, ["unknown"])], []);
    for (const tree of trees) {
      expect(tree.processes.every(item => !!item.role && !!item.roleSource && !!item.roleEvidence)).toBe(true);
      expect(Object.values(tree.roleCounts).reduce((sum, count) => sum + count!, 0)).toBe(tree.processes.length);
    }
  });
});

test("Codex is catalogued and inline code is not command evidence", () => {
  expect(HARNESS_DEFINITIONS.some(definition => definition.id === "codex")).toBe(true);
  expect(analyzeCommand(proc(1, 0, ["node", "-e", "require('vite')"]))).toEqual({
    anchors: [{ name: "node", path: "node", rest: [] }],
  });
});

describe("review regressions", () => {
  const promptAndDataCases: Array<[string, string[], ProcessRole]> = [
    ['bash -c "grep -rn @openai/codex node_modules/.package-lock.json"', ["bash", "-c", "grep -rn @openai/codex node_modules/.package-lock.json"], "shell"],
    ['bash -c "pip install aider-chat && python run.py"', ["bash", "-c", "pip install aider-chat && python run.py"], "shell"],
    ['bash -c "ls ~/.lmstudio/models"', ["bash", "-c", "ls ~/.lmstudio/models"], "shell"],
    ['bash -c "git diff -- src/text-generation-webui.ts"', ["bash", "-c", "git diff -- src/text-generation-webui.ts"], "shell"],
    ['sh -c "echo hi > /tmp/ollama"', ["sh", "-c", "echo hi > /tmp/ollama"], "shell"],
    ["node dist/cli.js --prompt with an embedded harness path", ["node", "dist/cli.js", "--prompt", "migrate from @anthropic-ai/claude-code/sdk"], "tool"],
    ["node -e require of a Codex package path", ["node", "-e", "require('/x/node_modules/@openai/codex/bin/codex.js')"], "tool"],
    ["python -c open of an Ollama path", ["python", "-c", "open('/x/ollama')"], "tool"],
    ["python3 scanner with an Open Interpreter data path", ["python3", "tools/scan.py", "/w/vendor/open-interpreter/"], "tool"],
  ];
  test.each(promptAndDataCases)("B1 %s", (_name, argv, role) => {
    const input = makeFixture(argv);
    expect(classifyTreeRoles(input.tree).get(input.pid)?.role).toBe(role);
  });

  const unsafeAnchorCases: Array<[string, Fixture, ProcessRole]> = [
    ["Node script path with spaces does not expose its argument", makeFixture(["node", "/Users/John Doe/proj/agent.js", "codex"]), "tool"],
    ["Python script path with spaces does not expose a Codex data path", makeFixture(["python3", "/Users/John Doe/proj/scan.py", "/x/node_modules/@openai/codex/bin/codex.js"]), "tool"],
    ["Node script path with spaces does not expose an MCP data path", makeFixture(["node", "/Users/John Doe/proj/run.js", "/x/node_modules/@modelcontextprotocol/server-x"]), "tool"],
    ["Claude Code entry point with spaces remains a harness", makeFixture(["node", "/Users/John Doe/proj/node_modules/@anthropic-ai/claude-code/cli.js"]), "subagent"],
    ["unsafe positional text stops before a Codex MCP argument", makeFixture(["codex", "unsafe data", "mcp-server"]), "subagent"],
    ["env assignment with spaces keeps the program anchor", makeFixture(["env", "MESSAGE=hello world", "vite"]), "dev-server"],
    ["Windows argv Claude Code path remains a harness", makeFixture(["node.exe", String.raw`C:\Users\John Doe\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js`], { targetExtra: { name: "node.exe" } }), "subagent"],
    ["Windows argv Codex path remains a harness", makeFixture(["node.exe", String.raw`C:\Users\John Doe\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`], { targetExtra: { name: "node.exe" } }), "subagent"],
    ["Windows argv MCP server path remains an MCP server", makeFixture(["node.exe", String.raw`C:\Users\John Doe\AppData\Roaming\npm\node_modules\@modelcontextprotocol\server-filesystem\dist\index.js`], { targetExtra: { name: "node.exe" } }), "mcp-server"],
    ["Windows cmdline-only Claude Code path remains a harness", makeFixture(["node.exe"], { targetExtra: {
      name: "node.exe", argv: undefined,
      cmdline: String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\John Doe\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js"`,
    } }), "subagent"],
    ["Windows cmdline-only Codex path remains a harness", makeFixture(["node.exe"], { targetExtra: {
      name: "node.exe", argv: undefined,
      cmdline: String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\John Doe\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js"`,
    } }), "subagent"],
    ["Windows cmdline-only MCP server path remains an MCP server", makeFixture(["node.exe"], { targetExtra: {
      name: "node.exe", argv: undefined,
      cmdline: String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\John Doe\AppData\Roaming\npm\node_modules\@modelcontextprotocol\server-filesystem\dist\index.js"`,
    } }), "mcp-server"],
  ];
  test.each(unsafeAnchorCases)("S4 %s", (_name, input, role) => {
    expect(classifyTreeRoles(input.tree).get(input.pid)?.role).toBe(role);
  });

  test("B1 bash -c codex does not count the real Codex child twice", () => {
    const processes = [proc(1, 0, ["claude"]), proc(2, 1, ["bash", "-c", "codex"]), proc(3, 2, ["codex"])];
    const assignments = classifyTreeRoles({
      jobId: "launcher", harness: "claude-code", rootPid: 1, managed: false, processes,
    });
    expect(assignments.get(2)?.role).toBe("shell");
    expect(assignments.get(3)?.role).toBe("subagent");
    expect([...assignments.values()].filter(assignment => assignment.role === "subagent")).toHaveLength(1);
  });

  test.each([
    ["Node Claude Code entry point", ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]],
    ["Python Aider module", ["python", "-m", "aider"]],
    ["uvx Aider", ["uvx", "aider"]],
  ])("B3 preserves positive harness recognition for %s", (_name, argv) => {
    const input = makeFixture(argv);
    const assignment = classifyTreeRoles(input.tree).get(input.pid);
    expect(assignment?.role).toBe("subagent");
    expect(assignment?.source).toBe("harness");
  });

  const combinedFlagCases: Array<[string, string[]]> = [
    ["node -pe", ["node", "-pe", "require('/x/node_modules/@modelcontextprotocol/server-x')"]],
    ["python -Sc", ["python", "-Sc", "x='/x/_pytest/'"]],
    ["python3 -Ic", ["python3", "-Ic", "x='/vitest/dist/'"]],
  ];
  test.each(combinedFlagCases)("S1 combined value-taking flag %s stays a tool", (_name, argv) => {
    const input = makeFixture(argv);
    expect(classifyTreeRoles(input.tree).get(input.pid)?.role).toBe("tool");
  });

  const pythonInlineValueFlagCases: Array<[string, string[], ProcessRole]> = [
    ["-Werror keeps the Python script as the program", ["python3", "-Werror", "tools/scan.py", "/x/node_modules/@openai/codex/bin/codex.js"], "tool"],
    ["-Wonce keeps the Python script as the program", ["python3", "-Wonce", "tools/scan.py", "/x/ollama"], "tool"],
    ["-Xtracemalloc keeps the Python script as the program", ["python3", "-Xtracemalloc", "tools/scan.py", "/x/aider"], "tool"],
    ["-Wmodule keeps the Python script as the program", ["python3", "-Wmodule", "tools/scan.py", "/x/ollama"], "tool"],
    ["-Xfaulthandler keeps the Python script as the program", ["python3", "-Xfaulthandler", "tools/scan.py", "/x/aider"], "tool"],
    ["-Werror keeps the Python script before an MCP package path", ["python3", "-Werror", "tools/scan.py", ".../@modelcontextprotocol/server-x/index.js"], "tool"],
    ["-Werror keeps the Python script before a Jest argument", ["python3", "-Werror", "tools/scan.py", "jest"], "tool"],
  ];
  test.each(pythonInlineValueFlagCases)("S5 %s", (_name, argv, role) => {
    const input = makeFixture(argv);
    expect(classifyTreeRoles(input.tree).get(input.pid)?.role).toBe(role);
  });

  test.each([
    ["backslash escaped quotes", String.raw`node.exe -e "console.log(\"/x/@modelcontextprotocol/server-a\")"`],
    ["doubled quotes", String.raw`node.exe -e "console.log(""quoted"")"`],
  ])("S2 Windows cmdline-only parsing handles %s", (_name, cmdline) => {
    const input = makeFixture(["node.exe"], { targetExtra: { name: "node.exe", argv: undefined, cmdline } });
    expect(analyzeCommand({ name: "node.exe", argv: undefined, cmdline })).toEqual({
      anchors: [{ name: "node", path: "node.exe", rest: [] }],
    });
    expect(classifyTreeRoles(input.tree).get(input.pid)?.role).toBe("tool");
  });

  test("S6 Windows argv splitting follows the modern MSVC C runtime quote rules", () => {
    expect(analyzeCommand({ name: "node.exe", argv: undefined, cmdline: String.raw`node.exe -e "a""b c" d` })).toEqual({
      anchors: [
        { name: "node", path: "node.exe", rest: ["d"] },
        { name: "d", path: "d", rest: [] },
      ],
    });
    expect(analyzeCommand({ name: "node.exe", argv: undefined, cmdline: String.raw`node.exe """" x` })).toEqual({
      anchors: [{ name: "node", path: "node.exe", rest: [] }],
    });
  });

  test("S3 a custom root override remembers its detected harness for launcher children", () => {
    const tree = {
      jobId: "custom-codex", harness: "custom" as const, rootPid: 1, managed: false,
      processes: [proc(1, 0, ["codex"]), proc(2, 1, ["codex"])],
    };
    const assignments = classifyTreeRoles(tree);
    expect(assignments.get(1)).toEqual({ role: "agent", source: "harness", evidence: "root: harness codex" });
    expect(assignments.get(2)).toEqual({
      role: "agent", source: "harness", evidence: "launcher chain: harness codex under pid 1",
    });
  });

  test("N1 invalid nested job IDs use a fixed evidence placeholder", () => {
    const malformedId = "S3CRET\nroles: fake";
    const input = makeFixture(["unknown-worker"], {
      tagId: "outer",
      targetExtra: { envTags: { AGTOP_JOB_ID: malformedId, AGTOP_HARNESS: "codex" } },
    });
    const assignment = classifyTreeRoles(input.tree).get(input.pid)!;
    expect(assignment).toEqual({ role: "subagent", source: "job", evidence: "nested job unknown (codex)" });
    expect(assignment.evidence).not.toContain(malformedId);
    expect(assignment.evidence).not.toContain("roles: fake");
  });

  test("N2 uv tool run unwraps to its MCP executable", () => {
    const input = makeFixture(["uv", "tool", "run", "mcp-server-x"]);
    expect(classifyTreeRoles(input.tree).get(input.pid)?.role).toBe("mcp-server");
  });

  test("N3 Codex model values do not hide its MCP subcommand", () => {
    const input = makeFixture(["codex", "--model", "o3", "mcp-server"]);
    expect(classifyTreeRoles(input.tree).get(input.pid)?.role).toBe("mcp-server");
  });

});
