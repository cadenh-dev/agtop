import { base, detectHarness, harnessKind, harnesses, normalize, tokens } from "./harnesses.js";
import type { HarnessType, ProcessRole, RawOsProcess, RoleSource } from "./types.js";

export interface CommandAnchor {
  name: string;
  path: string;
  rest: readonly string[];
}

export interface CommandFacts {
  anchors: readonly CommandAnchor[];
  module?: { name: string; rest: readonly string[] };
}

const SKIP_NEXT = new Set([
  "-e", "--eval", "-p", "--print", "-c", "--command", "-r", "--require", "--import", "--loader",
  "--experimental-loader", "-C", "--conditions", "--env-file", "-X", "-W", "--from", "--with", "--python",
  "--package", "--cwd", "--config",
]);
const ROLE_INTERPRETERS = new Set([
  "node", "nodejs", "bun", "bunx", "deno", "npx", "pnpx", "uv", "uvx", "pipx", "py", "env",
]);
const WRAPPER_SUBCOMMANDS = new Set(["run", "tool", "exec", "x", "dlx"]);
const INLINE_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PACKAGE_SPEC = /^(?:(@[^/@\s]+\/[^/@\s]+)|([^/@\s]+))(?:@[^/\s]*|==[^/\s]*)$/;

function positional(list: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (SKIP_NEXT.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    result.push(token.toLowerCase());
  }
  return result;
}

function stripPackageSpec(token: string): string {
  const match = PACKAGE_SPEC.exec(token);
  return match ? (match[1] ?? match[2]) : token;
}

function isRoleInterpreter(name: string): boolean {
  return ROLE_INTERPRETERS.has(name) || /^python\d*(\.\d+)?$/.test(name);
}

/** Build safe executable and entry-point facts without looking at cwd or prompt text. */
export function analyzeCommand(p: Pick<RawOsProcess, "name" | "cmdline" | "argv">): CommandFacts {
  let argv = p.argv?.length ? [...p.argv] : tokens(p.cmdline);
  if (!argv.length) argv = [p.name];
  const exe = argv[0];
  const entry = argv.slice(1);
  const facts: { anchors: CommandAnchor[]; module?: { name: string; rest: readonly string[] } } = {
    anchors: [{ name: base(exe), path: normalize(exe), rest: positional(entry) }],
  };
  const processName = base(p.name);
  if (processName !== base(exe)) {
    facts.anchors.push({ name: processName, path: normalize(p.name), rest: positional(entry) });
  }

  if (!isRoleInterpreter(base(exe)) && !isRoleInterpreter(processName)) return facts;

  let skippedWrapperSubcommand = false;
  for (let i = 0; i < entry.length; i++) {
    const token = entry[i];
    if (token === "-m" && i + 1 < entry.length) {
      facts.module = {
        name: entry[i + 1].toLowerCase().replace(/\\/g, "/"),
        rest: positional(entry.slice(i + 2)),
      };
      break;
    }
    if (SKIP_NEXT.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (base(exe) === "env" && INLINE_ASSIGNMENT.test(token)) continue;
    if (!skippedWrapperSubcommand && WRAPPER_SUBCOMMANDS.has(token.toLowerCase())) {
      skippedWrapperSubcommand = true;
      continue;
    }
    const program = stripPackageSpec(token);
    facts.anchors.push({ name: base(program), path: normalize(program), rest: positional(entry.slice(i + 1)) });
    break;
  }
  return facts;
}

export interface RoleRule {
  /** Exact anchor basenames (lowercase, platform extension stripped by base()). */
  binaries?: readonly string[];
  binaryPrefixes?: readonly string[];
  /** Matches only when the name is longer than the suffix. */
  binarySuffixes?: readonly string[];
  /** Normalized substrings of an anchor path. Never cwd. */
  paths?: readonly string[];
  /** `-m` module equality or dotted child. */
  modules?: readonly string[];
  modulePrefixes?: readonly string[];
  /** Space-separated positional sequences after the matched anchor or module. */
  args?: readonly string[];
  /** Skip this rule when any anchor path contains one of these. */
  excludePaths?: readonly string[];
}

export interface RoleDefinition {
  id: string;
  role: Exclude<ProcessRole, "agent" | "subagent" | "tool">;
  label: string;
  rules: readonly RoleRule[];
  note?: string;
}

/** Ordered rules: MCP server matches precede harness detection; all others follow it. */
export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    id: "agent-mcp-mode", role: "mcp-server", label: "Agent CLI in MCP server mode", rules: [
      { binaries: ["codex"], args: ["mcp-server"] },
      { binaries: ["claude"], args: ["mcp serve"] },
      { paths: ["@anthropic-ai/claude-code"], args: ["mcp serve"] },
      { binaries: ["goose"], args: ["mcp"] },
      { binaries: ["agtop"], args: ["mcp"] },
    ],
  },
  {
    id: "mcp-servers", role: "mcp-server", label: "Model Context Protocol servers", rules: [
      { paths: ["@modelcontextprotocol/server-", "@playwright/mcp"] },
      { binaryPrefixes: ["mcp-server-", "mcp-remote", "mcp-proxy"] },
      { binarySuffixes: ["-mcp", "-mcp-server", "_mcp"] },
      { modulePrefixes: ["mcp_server_"] },
      { modules: ["mcp_server", "fastmcp"] },
      { binaries: ["fastmcp", "mcp"], args: ["run", "dev"] },
    ],
  },
  {
    id: "language-servers", role: "language-server", label: "Language servers", rules: [
      { binarySuffixes: ["-language-server", "-langserver", "-languageserver", "-lsp", "_lsp"] },
      { binaries: ["tsserver", "typingsinstaller", "vtsls", "rust-analyzer", "gopls", "clangd", "jdtls", "pylsp", "pyls",
        "solargraph", "zls", "omnisharp", "csharp-ls", "terraform-ls", "marksman", "svelteserver", "elixir-ls", "metals",
        "tinymist", "texlab", "nixd", "haskell-language-server-wrapper"] },
      { binaries: ["ruff"], args: ["server"] },
      { binaries: ["biome"], args: ["lsp-proxy", "__run_server"] },
      { binaries: ["deno"], args: ["lsp"] },
      { binaries: ["taplo"], args: ["lsp"] },
      { modules: ["pylsp", "pyls", "jedi_language_server", "ruff_lsp"] },
    ],
  },
  {
    id: "test-runners", role: "test-runner", label: "Test runners", rules: [
      { binaries: ["jest", "vitest", "mocha", "jasmine", "pytest", "py.test", "tox", "nox", "phpunit", "rspec", "karma",
        "ctest", "cargo-nextest", "gotestsum", "nyc", "c8"] },
      { binaries: ["playwright"], args: ["test"] },
      { binaries: ["cypress"], args: ["run", "open"] },
      { binaries: ["bun", "deno", "swift", "dotnet"], args: ["test"] },
      { binaries: ["cargo"], args: ["test", "nextest"] },
      { binaries: ["go"], args: ["test"] },
      { binaries: ["mvn", "mvnw", "gradle", "gradlew"], args: ["test"] },
      { modules: ["pytest", "unittest", "nose2", "tox"] },
      { paths: ["/jest-worker/", "/vitest/dist/", "/tinypool/dist/", "/@playwright/test/", "/_pytest/"] },
    ],
  },
  {
    id: "build-subcommands", role: "build", label: "Build subcommands", rules: [
      { binaries: ["vite", "next", "nuxt", "nuxi", "astro", "parcel", "remix", "ng", "svelte-kit"], args: ["build"] },
      { binaries: ["bun"], args: ["build"] },
      { binaries: ["deno"], args: ["compile", "bundle"] },
      { binaries: ["cargo"], args: ["build", "check", "clippy", "doc", "rustc"] },
      { binaries: ["go"], args: ["build", "install", "vet", "generate"] },
      { binaries: ["dotnet"], args: ["build", "publish", "pack"] },
      { binaries: ["swift", "zig"], args: ["build"] },
    ],
  },
  {
    id: "dev-servers", role: "dev-server", label: "Dev servers", rules: [
      { binaries: ["vite", "webpack-dev-server", "parcel", "nodemon", "live-server", "http-server", "browser-sync",
        "start-storybook", "uvicorn", "gunicorn", "hypercorn", "daphne", "jupyter-lab", "jupyter-notebook"] },
      { binaries: ["next", "nuxt", "nuxi", "astro", "remix", "wrangler", "netlify", "vercel", "storybook"], args: ["dev", "start", "preview"] },
      { binaries: ["webpack", "ng", "vue-cli-service"], args: ["serve"] },
      { binaries: ["react-scripts"], args: ["start"] },
      { binaries: ["rails"], args: ["server", "s"] },
      { binaries: ["manage", "django-admin"], args: ["runserver"] },
      { binaries: ["flask"], args: ["run"] },
      { binaries: ["php"], args: ["artisan serve"] },
      { binaries: ["hugo", "jekyll", "mkdocs", "docusaurus"], args: ["server", "serve", "start"] },
      { binaries: ["jupyter"], args: ["lab", "notebook", "server"] },
      { binaries: ["streamlit"], args: ["run"] },
      { binaries: ["caddy"], args: ["run", "file-server"] },
      { modules: ["http.server", "uvicorn", "gunicorn", "hypercorn", "jupyterlab", "notebook"] },
      { modules: ["flask", "streamlit"], args: ["run"] },
      { modules: ["django"], args: ["runserver"] },
    ],
  },
  {
    id: "build-tools", role: "build", label: "Compilers, bundlers and build systems", rules: [
      { binaries: ["tsc", "tsgo", "esbuild", "webpack", "rollup", "rolldown", "tsup", "tsdown", "swc", "babel", "make", "gmake",
        "ninja", "cmake", "msbuild", "bazel", "bazelisk", "buck2", "rustc", "cc1", "cc1plus", "cc1obj", "clang", "clang++",
        "gcc", "g++", "ld", "ld64", "lld", "ld.lld", "swiftc", "swift-frontend", "javac", "kotlinc", "xcodebuild", "mvn",
        "mvnw", "gradle", "gradlew", "sbt"] },
    ],
  },
  {
    id: "browsers", role: "browser", label: "Browsers and WebDriver", rules: [
      { binaries: ["chrome", "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "google chrome",
        "google chrome for testing", "chrome-headless-shell", "headless_shell", "msedge", "microsoft edge", "firefox",
        "firefox-bin", "chromedriver", "geckodriver", "msedgedriver", "safaridriver"] },
      { binaryPrefixes: ["google chrome", "chromium", "microsoft edge", "chrome_crashpad"] },
      { paths: ["/ms-playwright/", "/.cache/puppeteer/"] },
    ],
  },
  {
    id: "version-control", role: "git", label: "Version control", rules: [
      { binaries: ["git", "gh", "glab", "hg", "jj", "svn", "lazygit", "tig", "gitui"] },
      { binaryPrefixes: ["git-"] },
      { paths: ["/libexec/git-core/"] },
    ],
  },
  {
    id: "package-managers", role: "package-manager", label: "Package managers and script runners", rules: [
      { binaries: ["npm", "npm-cli", "pnpm", "yarn", "yarnpkg", "corepack", "pip", "pip3", "poetry", "pdm", "pipenv", "conda",
        "mamba", "micromamba", "brew", "port", "apt", "apt-get", "dnf", "yum", "pacman", "apk", "zypper", "winget", "choco",
        "scoop", "gem", "bundle", "bundler", "composer", "nuget", "rustup", "cargo-binstall", "volta"] },
      { binaryPrefixes: ["pip3."] },
      { binaries: ["bun"], args: ["install", "i", "add", "a", "remove", "rm", "update", "upgrade", "link", "unlink", "pm", "outdated", "publish", "patch"] },
      { binaries: ["deno"], args: ["install", "add", "remove", "outdated", "cache"] },
      { binaries: ["uv"], args: ["pip", "add", "remove", "sync", "lock", "venv", "tool install", "tool upgrade", "tool uninstall"] },
      { binaries: ["cargo"], args: ["install", "add", "remove", "fetch", "update", "vendor"] },
      { binaries: ["go"], args: ["get", "mod"] },
      { binaries: ["dotnet"], args: ["restore", "add", "tool"] },
      { binaries: ["pipx"], args: ["install", "upgrade", "uninstall", "inject", "reinstall"] },
      { modules: ["pip", "ensurepip", "poetry", "pipenv"] },
    ],
  },
  {
    id: "shells", role: "shell", label: "Shells and terminal multiplexers", rules: [
      { binaries: ["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "cmd",
        "powershell", "pwsh", "-sh", "-bash", "-zsh", "-fish", "tmux", "screen", "login"] },
    ],
  },
];

export const PRE_HARNESS_ROLES: ReadonlySet<ProcessRole> = new Set(["mcp-server"]);

function matchesArgs(args: readonly string[] | undefined, rest: readonly string[]): string | undefined | null {
  if (!args) return null;
  const matched = args.find(sequence => sequence.split(" ").every((part, index) => rest[index] === part));
  return matched;
}

/** Return only catalog literals and argument literals, never process-provided text. */
export function matchRoleRule(rule: RoleRule, facts: CommandFacts): string | undefined {
  if (rule.excludePaths?.some(fragment => facts.anchors.some(anchor => anchor.path.includes(fragment)))) return undefined;

  for (const anchor of facts.anchors) {
    let how: string | undefined;
    const binary = rule.binaries?.find(literal => anchor.name === literal);
    if (binary) how = `binary ${binary}`;
    if (!how) {
      const prefix = rule.binaryPrefixes?.find(literal => anchor.name.startsWith(literal));
      if (prefix) how = `binary prefix ${prefix}`;
    }
    if (!how) {
      const suffix = rule.binarySuffixes?.find(literal => anchor.name.length > literal.length && anchor.name.endsWith(literal));
      if (suffix) how = `binary suffix ${suffix}`;
    }
    if (!how) {
      const path = rule.paths?.find(literal => anchor.path.includes(literal));
      if (path) how = `path ${path}`;
    }
    if (!how) continue;
    const args = matchesArgs(rule.args, anchor.rest);
    if (args === undefined) continue;
    return how + (args === null ? "" : ` + args "${args}"`);
  }

  if (!facts.module) return undefined;
  let how: string | undefined;
  const module = rule.modules?.find(literal => facts.module!.name === literal || facts.module!.name.startsWith(`${literal}.`));
  if (module) how = `module ${module}`;
  if (!how) {
    const prefix = rule.modulePrefixes?.find(literal => facts.module!.name.startsWith(literal));
    if (prefix) how = `module prefix ${prefix}`;
  }
  if (!how) return undefined;
  const args = matchesArgs(rule.args, facts.module.rest);
  if (args === undefined) return undefined;
  return how + (args === null ? "" : ` + args "${args}"`);
}

export interface RoleTreeInput {
  jobId: string;
  harness: HarnessType;
  rootPid: number;
  /** Job ID carried in AGTOP_JOB_ID by this tree's own processes. */
  tagId?: string;
  /** True for record-backed and tag-backed trees. */
  managed: boolean;
  processes: readonly RawOsProcess[];
}

export interface RoleAssignment {
  role: ProcessRole;
  source: RoleSource;
  evidence: string;
}

export const ROLE_ORDER: readonly ProcessRole[] = [
  "agent", "subagent", "mcp-server", "inference-server", "dev-server", "language-server", "test-runner", "build",
  "package-manager", "git", "browser", "shell", "tool",
];

export const ROLE_INFO: Readonly<Record<ProcessRole, { label: string; description: string }>> = {
  agent: { label: "Agent", description: "The tree's root agent and its own re-exec or shim chain." },
  subagent: { label: "Subagent", description: "Another agent harness running under an agent." },
  "mcp-server": { label: "MCP server", description: "A Model Context Protocol server." },
  "inference-server": { label: "Inference server", description: "A local model inference server." },
  "dev-server": { label: "Dev server", description: "A development or preview web server." },
  "language-server": { label: "Language server", description: "An LSP or editor intelligence server." },
  "test-runner": { label: "Test runner", description: "A test framework or one of its workers." },
  build: { label: "Build", description: "A compiler, bundler, or build system." },
  "package-manager": { label: "Package manager", description: "A package installer or script runner." },
  git: { label: "Version control", description: "Git and other version control commands or helpers." },
  browser: { label: "Browser", description: "A browser, headless browser, or WebDriver process." },
  shell: { label: "Shell", description: "A shell or terminal multiplexer." },
  tool: { label: "Tool", description: "Any other command run in the agent tree." },
};

const INHERITABLE = new Set<ProcessRole>([
  "mcp-server", "language-server", "test-runner", "build", "dev-server", "browser", "inference-server",
]);
const ROLE_RULE_PHASE_A = PRE_HARNESS_ROLES;

function processDepths(processes: readonly RawOsProcess[], byPid: ReadonlyMap<number, RawOsProcess>): Map<number, number> {
  const depths = new Map<number, number>();
  const orderedPids = processes.map(process => process.pid).sort((a, b) => a - b);
  for (const startingPid of orderedPids) {
    if (depths.has(startingPid)) continue;
    const path: number[] = [];
    const positions = new Map<number, number>();
    let currentPid = startingPid;
    while (!depths.has(currentPid)) {
      const cycleStart = positions.get(currentPid);
      if (cycleStart !== undefined) {
        for (let i = cycleStart; i < path.length; i++) depths.set(path[i], 0);
        break;
      }
      positions.set(currentPid, path.length);
      path.push(currentPid);
      const current = byPid.get(currentPid);
      const parent = current && byPid.get(current.ppid);
      if (!parent) {
        depths.set(currentPid, 0);
        break;
      }
      currentPid = parent.pid;
    }
    while (path.length) {
      const pid = path.pop()!;
      if (depths.has(pid)) continue;
      const process = byPid.get(pid)!;
      const parent = byPid.get(process.ppid);
      depths.set(pid, parent ? (depths.get(parent.pid) ?? 0) + 1 : 0);
    }
  }
  return depths;
}

/** Classify one already-correlated tree. This function performs no operating-system calls. */
export function classifyTreeRoles(tree: RoleTreeInput): Map<number, RoleAssignment> {
  const byPid = new Map(tree.processes.map(process => [process.pid, process]));
  const depths = processDepths(tree.processes, byPid);
  const ordered = [...tree.processes].sort((a, b) => (depths.get(a.pid)! - depths.get(b.pid)!) || a.pid - b.pid);
  const assignments = new Map<number, RoleAssignment>();
  const harnessByPid = new Map<number, HarnessType | undefined>();
  const factsByPid = new Map<number, CommandFacts>();
  const nearestMeaningfulByPid = new Map<number, { pid: number; role: ProcessRole } | null>();

  const getHarness = (process: RawOsProcess): HarnessType | undefined => {
    if (!harnessByPid.has(process.pid)) {
      harnessByPid.set(process.pid, detectHarness({ name: process.name, cmdline: process.cmdline, argv: process.argv }));
    }
    return harnessByPid.get(process.pid);
  };
  const getFacts = (process: RawOsProcess): CommandFacts => {
    let facts = factsByPid.get(process.pid);
    if (!facts) {
      facts = analyzeCommand(process);
      factsByPid.set(process.pid, facts);
    }
    return facts;
  };
  const nearestMeaningfulAncestor = (pid: number | undefined): { pid: number; role: ProcessRole } | null => {
    const skipped: number[] = [];
    const visited = new Set<number>();
    let candidate: { pid: number; role: ProcessRole } | null = null;
    let current = pid === undefined ? undefined : byPid.get(pid);
    while (current && !visited.has(current.pid)) {
      visited.add(current.pid);
      if (nearestMeaningfulByPid.has(current.pid)) {
        candidate = nearestMeaningfulByPid.get(current.pid)!;
        break;
      }
      const role = assignments.get(current.pid)?.role;
      if (role && role !== "tool") {
        candidate = { pid: current.pid, role };
        break;
      }
      skipped.push(current.pid);
      current = byPid.get(current.ppid);
    }
    for (const skippedPid of skipped) nearestMeaningfulByPid.set(skippedPid, candidate);
    return candidate;
  };
  const assign = (p: RawOsProcess, role: ProcessRole, source: RoleSource, evidence: string): RoleAssignment => {
    const assignment = { role, source, evidence };
    assignments.set(p.pid, assignment);
    nearestMeaningfulByPid.set(p.pid, role === "tool"
      ? nearestMeaningfulAncestor(byPid.get(p.pid)?.ppid)
      : { pid: p.pid, role });
    return assignment;
  };
  const assignCatalog = (p: RawOsProcess, phaseA: boolean): RoleAssignment | undefined => {
    const facts = getFacts(p);
    let match: { role: RoleDefinition["role"]; evidence: string } | undefined;
    for (const definition of ROLE_DEFINITIONS) {
      if (ROLE_RULE_PHASE_A.has(definition.role) !== phaseA) continue;
      for (const rule of definition.rules) {
        const how = matchRoleRule(rule, facts);
        if (how) {
          match = { role: definition.role, evidence: `${definition.id}: ${how}` };
          break;
        }
      }
      if (match) break;
    }
    return match && assign(p, match.role, "catalog", match.evidence);
  };
  const inheritRole = (p: RawOsProcess): RoleAssignment | undefined => {
    const ancestor = nearestMeaningfulAncestor(p.ppid);
    return ancestor && INHERITABLE.has(ancestor.role)
      ? assign(p, ancestor.role, "inherited", `inherited from pid ${ancestor.pid} (${ancestor.role})`)
      : undefined;
  };
  const assignSocket = (p: RawOsProcess): RoleAssignment | undefined => {
    if (!p.listeningSockets?.length) return undefined;
    const socket = [...p.listeningSockets].sort((a, b) => a.port - b.port || a.address.localeCompare(b.address))[0];
    return assign(p, "dev-server", "socket", `socket: listening ${socket.address}:${socket.port}`);
  };

  for (const p of ordered) {
    const isRoot = p.pid === tree.rootPid;
    if (isRoot) {
      const kind = harnessKind(tree.harness);
      if (kind === "agent") {
        assign(p, "agent", tree.managed ? "job" : "harness", tree.managed
          ? `root of job ${tree.jobId} (${tree.harness})`
          : `root: harness ${tree.harness}`);
        continue;
      }
      if (kind === "server") {
        assign(p, "inference-server", tree.managed ? "job" : "harness", tree.managed
          ? `root of job ${tree.jobId} (${tree.harness})`
          : `root: harness ${tree.harness}`);
        continue;
      }
      if (assignCatalog(p, true)) continue;
      const detected = getHarness(p);
      if (detected) {
        const detectedKind = harnessKind(detected);
        if (detectedKind === "agent") {
          assign(p, "agent", "harness", `root: harness ${detected}`);
          continue;
        }
        if (detectedKind === "server") {
          assign(p, "inference-server", "harness", `root: harness ${detected}`);
          continue;
        }
      }
      if (assignCatalog(p, false)) continue;
      if (assignSocket(p)) continue;
      assign(p, "agent", "job", `root of job ${tree.jobId} (custom command)`);
      continue;
    }

    const nestedJobId = p.envTags?.AGTOP_JOB_ID;
    const nestedHarnessId = p.envTags?.AGTOP_HARNESS;
    if (nestedJobId && nestedJobId !== tree.tagId && nestedHarnessId && harnesses.includes(nestedHarnessId as HarnessType)) {
      const nestedHarness = nestedHarnessId as HarnessType;
      const kind = harnessKind(nestedHarness);
      if (kind === "agent") {
        assign(p, "subagent", "job", `nested job ${nestedJobId} (${nestedHarness})`);
        continue;
      }
      if (kind === "server") {
        assign(p, "inference-server", "job", `nested job ${nestedJobId} (${nestedHarness})`);
        continue;
      }
    }
    if (assignCatalog(p, true)) continue;

    const detected = getHarness(p);
    if (detected) {
      const kind = harnessKind(detected);
      if (kind === "agent") {
        const parent = byPid.get(p.ppid);
        const parentRole = parent && assignments.get(parent.pid)?.role;
        const parentHarness = parent
          ? parent.pid === tree.rootPid ? tree.harness : getHarness(parent)
          : undefined;
        if (parent && (parentRole === "agent" || parentRole === "subagent") && parentHarness === detected) {
          assign(p, parentRole, "harness", `launcher chain: harness ${detected} under pid ${parent.pid}`);
          continue;
        }
        if (!parent && detected === tree.harness && !byPid.has(tree.rootPid)) {
          assign(p, "agent", "harness", `harness ${detected}; recorded root pid ${tree.rootPid} not running`);
          continue;
        }
        assign(p, "subagent", "harness", `nested harness ${detected}`);
        continue;
      }
      if (kind === "server") {
        assign(p, "inference-server", "harness", `harness ${detected}`);
        continue;
      }
    }
    if (assignCatalog(p, false)) continue;
    if (inheritRole(p)) continue;
    if (assignSocket(p)) continue;
    assign(p, "tool", "fallback", "no matching rule");
  }
  return assignments;
}

export function countRoles(processes: readonly { role: ProcessRole }[]): Partial<Record<ProcessRole, number>> {
  const counts: Partial<Record<ProcessRole, number>> = {};
  for (const process of processes) counts[process.role] = (counts[process.role] ?? 0) + 1;
  return counts;
}

export function roleCatalog(): Array<{ role: ProcessRole; label: string; description: string; definitions: string[] }> {
  return ROLE_ORDER.map(role => ({
    role,
    ...ROLE_INFO[role],
    definitions: ROLE_DEFINITIONS.filter(definition => definition.role === role).map(definition => definition.id),
  }));
}
