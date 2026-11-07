import type { HarnessType, RawOsProcess } from "./types.js";

/** How a harness is used: an interactive coding agent, a local inference server, or a custom command. */
export type HarnessKind = "agent" | "server" | "custom";

export interface HarnessRule {
  /** Exact executable basenames, lowercased and without the platform extension. */
  binaries?: readonly string[];
  /** Executable basename prefixes, for versioned server builds such as koboldcpp_cuda. */
  binaryPrefixes?: readonly string[];
  /** Normalized substrings of an executable, script, module, or working-directory path. */
  paths?: readonly string[];
  /** Python modules accepted after `-m`; a dotted child module also matches its prefix. */
  modules?: readonly string[];
  /** The first non-flag argument must be one of these before a binary match is accepted. */
  requiresSubcommand?: readonly string[];
  /** A binary match is rejected when the executable or script path contains one of these. */
  excludePaths?: readonly string[];
}

export interface HarnessDefinition {
  id: HarnessType;
  label: string;
  kind: HarnessKind;
  rules: readonly HarnessRule[];
  note?: string;
}

/**
 * Recognition is deliberately evidence-based, never prompt-based. A rule may match an
 * executable basename, an install path, a Python module, or a subcommand. Generic names
 * (goose, gh, q, tabby, agent) always require a second signal to avoid false positives.
 */
export const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "agent",
    rules: [
      { binaries: ["claude", "claude-code"], excludePaths: ["anthropicclaude", "claude.app", "claude desktop"] },
      { paths: ["@anthropic-ai/claude-code"] },
    ],
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    kind: "agent",
    rules: [{ binaries: ["codex"], excludePaths: ["codex.app/contents/macos/"] }, { paths: ["@openai/codex"] }],
  },
  {
    id: "opencode",
    label: "OpenCode",
    kind: "agent",
    rules: [{ binaries: ["opencode"] }, { paths: ["@opencode/cli", "sst/opencode", "anomalyco/opencode"] }],
  },
  {
    id: "aider",
    label: "Aider",
    kind: "agent",
    rules: [{ binaries: ["aider", "aider-chat"] }, { modules: ["aider"] }, { paths: ["site-packages/aider", "aider-chat"] }],
  },
  {
    id: "goose",
    label: "Block Goose",
    kind: "agent",
    rules: [
      { binaries: ["goose"], requiresSubcommand: ["session", "run"] },
      { paths: ["block/goose", "aaif-goose"] },
    ],
    note: "pressly/goose is a database migration tool; a bare `goose` needs a session or run subcommand.",
  },
  {
    id: "deepseek-harness",
    label: "DeepSeek Harness",
    kind: "agent",
    rules: [{ binaries: ["dsh", "deepseek-harness"] }],
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    kind: "agent",
    rules: [{ binaries: ["gemini", "gemini-cli"] }, { paths: ["@google/gemini-cli"] }],
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    kind: "agent",
    rules: [{ binaries: ["qwen", "qwen-code"] }, { paths: ["@qwen-code/qwen-code"] }, { modules: ["qwen_agent"] }],
  },
  {
    id: "cursor-agent",
    label: "Cursor Agent",
    kind: "agent",
    rules: [{ binaries: ["cursor-agent"] }, { paths: ["/.cursor/bin/", "cursor-agent"] }],
    note: "The Cursor desktop editor is not treated as an agent; only the standalone CLI is matched.",
  },
  {
    id: "amp",
    label: "Sourcegraph Amp",
    kind: "agent",
    rules: [{ binaries: ["amp"] }, { paths: ["@ampcode/cli", "@sourcegraph/amp"] }],
  },
  {
    id: "crush",
    label: "Charm Crush",
    kind: "agent",
    rules: [{ binaries: ["crush"] }, { paths: ["charmbracelet/crush", "@charmland/crush"] }],
  },
  {
    id: "cline",
    label: "Cline",
    kind: "agent",
    rules: [{ binaries: ["cline"] }, { paths: ["node_modules/cline/", "saoudrizwan.claude-dev"] }],
  },
  {
    id: "roo-code",
    label: "Roo Code",
    kind: "agent",
    rules: [{ binaries: ["roo-cli", "roo-cline"] }, { paths: ["roo-veterinary.roo-cline"] }],
  },
  {
    id: "kilo-code",
    label: "Kilo Code",
    kind: "agent",
    rules: [{ binaries: ["kilo"] }, { paths: ["@kilocode/cli"] }],
  },
  {
    id: "continue-cli",
    label: "Continue",
    kind: "agent",
    rules: [{ binaries: ["continue"] }, { paths: ["@continuedev/cli"] }],
    note: "The short `cn` alias is ignored without a package path because it collides with common shell tools.",
  },
  {
    id: "openhands",
    label: "OpenHands",
    kind: "agent",
    rules: [{ binaries: ["openhands", "openhands-acp"] }, { modules: ["openhands_cli", "openhands"] }, { paths: ["openhands-ai"] }],
  },
  {
    id: "swe-agent",
    label: "SWE-agent",
    kind: "agent",
    rules: [{ binaries: ["sweagent", "mini-swe-agent"] }, { modules: ["sweagent"] }],
  },
  {
    id: "plandex",
    label: "Plandex",
    kind: "agent",
    rules: [{ binaries: ["plandex"] }, { paths: ["plandex-ai"] }],
  },
  {
    id: "mentat",
    label: "Mentat",
    kind: "agent",
    rules: [{ binaries: ["mentat"] }, { modules: ["mentat"] }],
  },
  {
    id: "gpt-engineer",
    label: "GPT Engineer",
    kind: "agent",
    rules: [{ binaries: ["gpt-engineer", "gpte"] }, { modules: ["gpt_engineer"] }],
  },
  {
    id: "open-interpreter",
    label: "Open Interpreter",
    kind: "agent",
    rules: [{ binaries: ["open-interpreter"] }, { modules: ["interpreter"] }, { paths: ["open-interpreter"] }],
    note: "The generic `interpreter` binary is not matched by name; only the module or package path is used.",
  },
  {
    id: "cody",
    label: "Sourcegraph Cody",
    kind: "agent",
    rules: [{ binaries: ["cody", "cody-agent"] }, { paths: ["@sourcegraph/cody"] }],
  },
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    kind: "agent",
    rules: [
      { binaries: ["copilot", "gh-copilot"] },
      { binaries: ["gh"], requiresSubcommand: ["copilot"] },
      { paths: ["@github/copilot", "@githubnext/github-copilot-cli", "gh-copilot"] },
    ],
    note: "IDE Copilot runs inside the editor; only the standalone CLI is recognized.",
  },
  {
    id: "amazon-q",
    label: "Amazon Q Developer",
    kind: "agent",
    rules: [
      { binaries: ["amazon-q"] },
      { binaries: ["q"], requiresSubcommand: ["chat", "doctor", "translate", "login"] },
      { paths: [".amazon-q", "amazon-q-developer-cli"] },
    ],
    note: "A bare `q` process is ignored because it collides with several unrelated tools.",
  },
  {
    id: "kiro",
    label: "Kiro",
    kind: "agent",
    rules: [{ binaries: ["kiro-cli"] }, { paths: ["kiro.dev"] }],
  },
  {
    id: "antigravity",
    label: "Google Antigravity",
    kind: "agent",
    rules: [
      { binaries: ["antigravity", "antigravity-cli", "antigravity-acp", "agy", "agy_acp_server", "localharness_external"] },
      { paths: ["antigravity-acp"] },
    ],
  },
  {
    id: "aichat",
    label: "AIChat",
    kind: "agent",
    rules: [{ binaries: ["aichat"] }],
  },
  {
    id: "shell-gpt",
    label: "ShellGPT",
    kind: "agent",
    rules: [{ binaries: ["sgpt"] }, { modules: ["sgpt", "shell_gpt"] }],
  },
  {
    id: "fabric",
    label: "Fabric",
    kind: "agent",
    rules: [{ binaries: ["fabric"] }, { modules: ["fabric"] }],
    note: "The Python Fabric deployment tool installs the `fab` command, not `fabric`.",
  },
  {
    id: "mods",
    label: "mods",
    kind: "agent",
    rules: [{ binaries: ["mods"] }],
  },
  {
    id: "llm",
    label: "LLM",
    kind: "agent",
    rules: [{ binaries: ["llm"] }, { modules: ["llm"] }],
  },
  {
    id: "smolagents",
    label: "smolagents",
    kind: "agent",
    rules: [{ binaries: ["smolagent", "smolagents"] }, { modules: ["smolagents"] }],
  },
  {
    id: "junie",
    label: "JetBrains Junie",
    kind: "agent",
    rules: [{ binaries: ["junie"] }, { paths: ["jetbrains/junie", "junie-cli"] }],
  },
  {
    id: "droid",
    label: "Factory Droid",
    kind: "agent",
    rules: [{ binaries: ["droid"] }, { paths: ["@factory-ai/droid"] }],
  },
  {
    id: "kimi",
    label: "Kimi CLI",
    kind: "agent",
    rules: [{ binaries: ["kimi"] }, { paths: ["moonshotai/kimi-cli", "@moonshot-ai/kimi"] }],
  },
  {
    id: "codebuff",
    label: "Codebuff",
    kind: "agent",
    rules: [{ binaries: ["codebuff"] }, { paths: ["codebuffai/codebuff", "@codebuffai/codebuff"] }],
  },
  {
    id: "ra-aid",
    label: "RA.Aid",
    kind: "agent",
    rules: [{ binaries: ["ra-aid"] }, { modules: ["ra_aid"] }],
  },
  {
    id: "tabby-agent",
    label: "Tabby Agent",
    kind: "agent",
    rules: [{ binaries: ["tabby-agent"] }, { paths: ["@tabbyml/tabby-agent"] }],
  },
  {
    id: "lemonade-server",
    label: "AMD Lemonade",
    kind: "server",
    rules: [{ binaries: ["lemonade-server", "lemonade"] }],
  },
  {
    id: "ollama",
    label: "Ollama",
    kind: "server",
    rules: [{ binaryPrefixes: ["ollama"] }],
  },
  {
    id: "llama-cpp",
    label: "llama.cpp",
    kind: "server",
    rules: [{ binaries: ["llama-server", "llama-cli"] }],
    note: "The legacy unqualified `server` binary is not matched without stronger evidence.",
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    kind: "server",
    rules: [{ binaries: ["llmster", "lms", "lm studio", "lm studio helper"] }, { paths: [".lmstudio"] }],
  },
  {
    id: "vllm",
    label: "vLLM",
    kind: "server",
    rules: [{ binaries: ["vllm"] }, { modules: ["vllm"] }],
  },
  {
    id: "sglang",
    label: "SGLang",
    kind: "server",
    rules: [{ binaries: ["sglang"] }, { modules: ["sglang"] }],
  },
  {
    id: "localai",
    label: "LocalAI",
    kind: "server",
    rules: [{ binaries: ["local-ai"] }],
  },
  {
    id: "koboldcpp",
    label: "KoboldCpp",
    kind: "server",
    rules: [{ binaryPrefixes: ["koboldcpp"] }],
  },
  {
    id: "text-generation-webui",
    label: "Text Generation WebUI",
    kind: "server",
    rules: [{ paths: ["text-generation-webui", "oobabooga"] }],
    note: "A generic `python server.py` only matches when its working directory identifies the project.",
  },
  {
    id: "jan",
    label: "Jan",
    kind: "server",
    rules: [{ binaries: ["jan", "nitro", "cortex"] }, { paths: ["@janhq"] }],
  },
  {
    id: "tabby",
    label: "Tabby",
    kind: "server",
    rules: [
      { binaries: ["tabby"], requiresSubcommand: ["serve"] },
      { binaries: ["tabby-cpu", "tabby-cuda"] },
      { paths: ["tabbyml"] },
    ],
    note: "The Tabby terminal emulator is only matched when its command contains the serve subcommand.",
  },
  {
    id: "open-webui",
    label: "Open WebUI",
    kind: "server",
    rules: [{ binaries: ["open-webui"] }, { modules: ["open_webui"] }],
  },
  {
    id: "aphrodite",
    label: "Aphrodite",
    kind: "server",
    rules: [{ binaries: ["aphrodite"] }, { modules: ["aphrodite"] }],
  },
  {
    id: "exllamav2",
    label: "ExLlamaV2 / TabbyAPI",
    kind: "server",
    rules: [{ binaries: ["exllamav2"] }, { modules: ["exllamav2"] }, { paths: ["tabbyapi"] }],
  },
  {
    id: "mlc-llm",
    label: "MLC LLM",
    kind: "server",
    rules: [{ binaries: ["mlc_llm"] }, { modules: ["mlc_llm"] }],
  },
  {
    id: "llama-cpp-python",
    label: "llama-cpp-python",
    kind: "server",
    rules: [{ modules: ["llama_cpp.server"] }, { paths: ["llama-cpp-python"] }],
  },
  {
    id: "tgi",
    label: "Text Generation Inference",
    kind: "server",
    rules: [{ binaries: ["text-generation-launcher", "text-generation-router", "text-generation-server"] }],
  },
  {
    id: "triton",
    label: "Triton Inference Server",
    kind: "server",
    rules: [{ binaries: ["tritonserver"] }],
  },
  {
    id: "mistralrs",
    label: "Mistral.rs",
    kind: "server",
    rules: [{ binaries: ["mistralrs-server", "mistralrs"] }],
  },
  {
    id: "xinference",
    label: "Xinference",
    kind: "server",
    rules: [{ binaries: ["xinference"] }, { modules: ["xinference"] }],
  },
  {
    id: "llamafile",
    label: "llamafile",
    kind: "server",
    rules: [{ binaryPrefixes: ["llamafile"] }],
  },
  {
    id: "mlx-lm",
    label: "MLX LM",
    kind: "server",
    rules: [{ binaries: ["mlx_lm.server"] }, { modules: ["mlx_lm.server"] }, { paths: ["mlx-lm"] }],
  },
  {
    id: "openllm",
    label: "OpenLLM",
    kind: "server",
    rules: [{ binaries: ["openllm"] }, { modules: ["openllm"] }],
  },
  {
    id: "custom",
    label: "Custom command",
    kind: "custom",
    rules: [],
  },
];

export const harnesses: readonly HarnessType[] = HARNESS_DEFINITIONS.map(definition => definition.id);
const definitions = new Map(HARNESS_DEFINITIONS.map(definition => [definition.id, definition]));

export function harnessLabel(id: HarnessType): string {
  return definitions.get(id)?.label ?? id;
}

export function harnessKind(id: HarnessType): HarnessKind {
  return definitions.get(id)?.kind ?? "custom";
}

/** Local inference servers report a local engine unless a launch record says otherwise. */
export function isLocalHarness(id: HarnessType): boolean {
  return harnessKind(id) === "server";
}

export function harnessCatalog(): Array<{ id: HarnessType; label: string; kind: HarnessKind }> {
  return HARNESS_DEFINITIONS.map(({ id, label, kind }) => ({ id, label, kind }));
}

export function searchHarnesses(query?: string): Array<{ id: HarnessType; label: string; kind: HarnessKind }> {
  const q = query?.toLowerCase().trim() ?? "";
  return harnessCatalog().filter(item => `${item.id} ${item.label} ${item.kind}`.toLowerCase().includes(q));
}

const wrappers = new Set([
  "node", "nodejs", "bun", "bunx", "deno", "python", "python3", "python3.12", "py",
  "uv", "uvx", "pipx", "npx", "pnpx", "cmd", "sh", "bash", "zsh", "fish", "powershell", "pwsh", "env",
]);
const wrapperSubcommands = new Set(["run", "tool", "exec", "x"]);
const scriptSuffix = /\.(js|cjs|mjs|py|cmd|bat|ps1|exe|sh)$/i;

function base(value: string): string {
  return (value.replace(/\\/g, "/").split("/").pop() || "")
    .replace(/\.(exe|cmd|bat|ps1|js|cjs|mjs|py|sh)$/i, "")
    .toLowerCase();
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function tokens(value: string): string[] {
  return (value.match(/"[^"]*"|'[^']*'|[^\s]+/g) || []).map(token => token.replace(/^["']|["']$/g, ""));
}

function isPathLike(token: string): boolean {
  return token.includes("/") || token.includes("\\") || scriptSuffix.test(token);
}

function moduleFrom(argv: string[]): string | undefined {
  const index = argv.findIndex((token, i) => token === "-m" && i + 1 < argv.length);
  return index >= 0 ? argv[index + 1].replace(/\\/g, "/").toLowerCase() : undefined;
}

function wrappedTool(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("-")) continue;
    if (wrapperSubcommands.has(token.toLowerCase())) continue;
    return base(token);
  }
  return undefined;
}

/**
 * Identify a process from its executable, entry-point path, Python module, or a
 * subcommand that disambiguates a shared name. Prompt text and arbitrary arguments
 * are never searched; this is why `git commit -m codex` is not an agent.
 */
export function detectHarness(
  p: Pick<RawOsProcess, "name" | "cmdline" | "argv"> & { cwd?: string },
): HarnessType | undefined {
  const argv = p.argv?.length ? p.argv : tokens(p.cmdline);
  const executable = base(argv[0] || p.name);
  const wrapper = wrappers.has(executable);
  const entry = argv.slice(1);
  const scriptNames = wrapper ? entry.filter(isPathLike).map(base) : [];
  const tool = wrapper ? wrappedTool(entry) : undefined;
  const names = new Set([base(p.name), base(argv[0] || ""), ...scriptNames, ...(tool ? [tool] : [])].filter(Boolean));
  // Only interpreters, shells, and package runners are unwrapped. Scanning every
  // argument would let prompt text such as a package path masquerade as an executable.
  const paths = [argv[0] || "", p.name, ...(wrapper ? entry.filter(isPathLike) : []), p.cwd || ""]
    .filter(Boolean)
    .map(normalize);
  const module = moduleFrom(argv);
  const subcommand = entry.find(token => !token.startsWith("-"))?.toLowerCase();

  for (const definition of HARNESS_DEFINITIONS) {
    for (const rule of definition.rules) {
      if (rule.excludePaths?.some(fragment => paths.some(value => value.includes(fragment)))) continue;
      if (rule.paths?.some(fragment => paths.some(value => value.includes(fragment)))) return definition.id;
      if (rule.modules && module && rule.modules.some(name => module === name || module.startsWith(`${name}.`))) return definition.id;
      const binary = rule.binaries?.some(name => names.has(name))
        || rule.binaryPrefixes?.some(prefix => [...names].some(name => name.startsWith(prefix)));
      if (binary && (!rule.requiresSubcommand || (subcommand !== undefined && rule.requiresSubcommand.includes(subcommand)))) return definition.id;
    }
  }
  return undefined;
}
