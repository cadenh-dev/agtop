import { describe, expect, test } from "bun:test";
import {
  HARNESS_DEFINITIONS,
  detectHarness,
  harnessCatalog,
  searchHarnesses,
  harnessKind,
  harnessLabel,
  type HarnessDefinition,
  type HarnessKind,
  type HarnessRule,
} from "../src/harnesses.js";
import type { HarnessType } from "../src/types.js";

type DetectInput = Parameters<typeof detectHarness>[0];

function ruleToProcess(def: HarnessDefinition, rule: HarnessRule): DetectInput | undefined {
  if (rule.binaries?.length) {
    const bin = rule.binaries.find(b => !b.includes(" "));
    if (bin) {
      const sub = rule.requiresSubcommand?.[0];
      if (rule.requiresSubcommand && !sub) return undefined;
      const cmd = sub ? `${bin} ${sub} --flags` : `${bin} --help`;
      return { name: bin, cmdline: cmd };
    }
  }
  if (rule.binaryPrefixes?.length) {
    const prefix = rule.binaryPrefixes[0];
    const name = `${prefix}_smoke`;
    return { name, cmdline: `${name} --listen` };
  }
  if (rule.modules?.length) {
    const mod = rule.modules[0];
    return { name: "python3.12", cmdline: `python3.12 -m ${mod}` };
  }
  if (rule.paths?.length) {
    const fragment = rule.paths[0];
    if (def.id === "text-generation-webui") {
      return { name: "python", cmdline: "python server.py", cwd: `/srv/${fragment}` };
    }
    const script = fragment.startsWith("/") ? `${fragment}/cli.js` : `/opt/pkg/${fragment}/dist/run.js`;
    return { name: "node", cmdline: `node ${script}` };
  }
  return undefined;
}

function syntheticPositive(def: HarnessDefinition): DetectInput | undefined {
  for (const rule of def.rules) {
    const input = ruleToProcess(def, rule);
    if (input && detectHarness(input) === def.id) return input;
  }
  return undefined;
}

const MANUAL_POSITIVES: Partial<Record<HarnessType, DetectInput>> = {
  "lm-studio": { name: "llmster", cmdline: "llmster" },
  "claude-code": {
    name: "node.exe",
    cmdline: 'node "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"',
  },
  codex: { name: "cmd.exe", cmdline: "cmd.exe /c codex.cmd", argv: ["cmd.exe", "/c", "codex.cmd"] },
  "copilot-cli": { name: "gh", cmdline: "gh copilot explain" },
  "amazon-q": { name: "q", cmdline: "q doctor" },
  tabby: { name: "tabby", cmdline: "tabby serve --model StarCoder" },
  goose: { name: "goose", cmdline: "goose run" },
  ollama: { name: "ollama", cmdline: "ollama serve" },
  koboldcpp: { name: "koboldcpp_cuda", cmdline: "koboldcpp_cuda --port 5001" },
  llamafile: { name: "llamafile-server", cmdline: "llamafile-server --host 127.0.0.1" },
  "llama-cpp-python": { name: "python", cmdline: "python -m llama_cpp.server" },
  "mlx-lm": { name: "python", cmdline: "python -m mlx_lm.server" },
  "open-interpreter": { name: "python", cmdline: "python -m interpreter" },
  aider: { name: "uvx", cmdline: "uvx aider" },
  "gemini-cli": { name: "npx", cmdline: "npx @google/gemini-cli" },
  vllm: { name: "python3", cmdline: "python3 -m vllm.entrypoints.openai.api_server" },
  antigravity: { name: "agy", cmdline: "agy acp --process-per-session" },
};

function positiveInput(def: HarnessDefinition): DetectInput | undefined {
  return MANUAL_POSITIVES[def.id] ?? syntheticPositive(def);
}

describe("harness catalog metadata", () => {
  test("catalog entries are unique and align with definitions", () => {
    const catalog = harnessCatalog();
    expect(catalog).toHaveLength(HARNESS_DEFINITIONS.length);
    expect(new Set(catalog.map(h => h.id)).size).toBe(catalog.length);
    for (const def of HARNESS_DEFINITIONS) {
      const row = catalog.find(h => h.id === def.id);
      expect(row).toEqual({ id: def.id, label: def.label, kind: def.kind });
      expect(harnessLabel(def.id)).toBe(def.label);
      expect(harnessKind(def.id)).toBe(def.kind);
    }
  });

  test.each([
    ["claude", ["claude-code"]],
    ["ollama", ["ollama"]],
    ["OpenAI", ["codex"]],
    ["custom", ["custom"]],
    ["", harnessCatalog().map(h => h.id)],
  ] as const)("catalogSearch(%j) returns expected ids", (query, expectedIds) => {
    const ids = searchHarnesses(query).map(h => h.id).sort();
    expect(ids).toEqual([...expectedIds].sort());
  });

  test('catalogSearch("server") matches id, label, or kind containing "server"', () => {
    const q = "server";
    const expected = harnessCatalog()
      .filter(h => `${h.id} ${h.label} ${h.kind}`.toLowerCase().includes(q))
      .map(h => h.id)
      .sort();
    expect(searchHarnesses(q).map(h => h.id).sort()).toEqual(expected);
    expect(expected).toContain("lemonade-server");
    expect(expected.every(id => harnessKind(id) === "server" || id.includes("server"))).toBe(true);
  });
});

describe("catalog-driven recognition", () => {
  for (const def of HARNESS_DEFINITIONS) {
    if (def.id === "custom") {
      test(`${def.id} is listed as custom and is not passively detected`, () => {
        expect(def.kind).toBe("custom");
        expect(detectHarness({ name: "my-tool", cmdline: "my-tool --agent" })).not.toBe("custom");
      });
      continue;
    }

    test(`recognizes ${def.id} (${def.kind}) from catalog-derived evidence`, () => {
      const input = positiveInput(def);
      expect(input).toBeDefined();
      const got = detectHarness(input!);
      expect(got).toBe(def.id);
      expect(harnessKind(got!)).toBe(def.kind);
    });
  }
});

describe("interpreter wrappers and path shapes", () => {
  const detect = (input: DetectInput) => detectHarness(input);

  test("POSIX node entry points", () => {
    expect(
      detect({
        name: "node",
        cmdline: "node /home/u/.npm/_npx/abc/node_modules/@openai/codex/bin/codex.js",
      }),
    ).toBe("codex");
    expect(detect({ name: "bun", cmdline: "bun /opt/@qwen-code/qwen-code/dist/cli.js" })).toBe("qwen-code");
  });

  test("Windows executables, case, and cmd shim", () => {
    expect(
      detect({
        name: "NODE.EXE",
        cmdline: 'node "D:\\tools\\node_modules\\@anthropic-ai\\claude-code\\cli.js"',
      }),
    ).toBe("claude-code");
    expect(detect({ name: "Codex.EXE", cmdline: "Codex.EXE exec" })).toBe("codex");
    expect(detect({ name: "cmd.exe", cmdline: "cmd.exe /C codex.CMD", argv: ["cmd.exe", "/C", "codex.CMD"] })).toBe(
      "codex",
    );
  });

  test("python, uv, uvx, and npx launchers", () => {
    expect(detect({ name: "python", cmdline: "python -m aider" })).toBe("aider");
    expect(detect({ name: "python3.11", cmdline: "python3.11 -m openhands" })).toBe("openhands");
    expect(detect({ name: "uv", cmdline: "uv run aider" })).toBe("aider");
    expect(detect({ name: "uvx", cmdline: "uvx sweagent" })).toBe("swe-agent");
    expect(detect({ name: "npx", cmdline: "npx @continuedev/cli" })).toBe("continue-cli");
  });

  test("explicit argv arrays are honored over cmdline tokenization", () => {
    expect(
      detect({
        name: "node",
        cmdline: "ignored",
        argv: ["node", "/usr/lib/node_modules/@google/gemini-cli/index.js"],
      }),
    ).toBe("gemini-cli");
  });
});

describe("negative and ambiguous cases", () => {
  const reject = (input: DetectInput) => expect(detectHarness(input)).toBeUndefined();

  test("prompt words and arbitrary args are ignored", () => {
    reject({ name: "git", cmdline: 'git commit -m "codex rollout"' });
    reject({ name: "node", cmdline: 'node -e "console.log(\'claude\')"' });
    reject({ name: "gh", cmdline: "gh issue create --title copilot" });
    reject({ name: "node", cmdline: "node /work/codex-project/server.js" });
  });

  test("generic names without a second signal", () => {
    reject({ name: "goose", cmdline: "goose up" });
    reject({ name: "goose", cmdline: "goose --help" });
    reject({ name: "gh", cmdline: "gh status" });
    reject({ name: "q", cmdline: "q" });
    reject({ name: "tabby", cmdline: "tabby" });
    reject({ name: "agent", cmdline: "agent run task" });
    reject({ name: "server", cmdline: "server --model x.gguf" });
  });

  test("lookalike install paths and excluded products", () => {
    reject({ name: "vim", cmdline: "vim", cwd: "/home/codex/bin" });
    reject({
      name: "claude",
      cmdline: "C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\claude.exe",
    });
    reject({ name: "ssh-agent", cmdline: "ssh-agent -s" });
  });

  test("empty or odd argv", () => {
    reject({ name: "", cmdline: "" });
    reject({ name: "node", cmdline: "node" });
    reject({ name: "python", cmdline: "python -m" });
    reject({ name: "---", cmdline: "--- weird" });
  });
});
