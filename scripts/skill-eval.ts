import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { gradePlan, validateRules, type AgentPlan, type Rule } from "./skill-eval-grade.js";

export interface Scenario { id: string; prompt: string; priorCalls?: { tool: string; args: Record<string, unknown>; result: unknown }[]; tools?: string[]; rules: Rule[] }
export function parsePlan(raw: string): AgentPlan {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = fenced ? [fenced, raw] : [raw];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]!;
      if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; continue; }
      if (ch === '"') quoted = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        const parsed = JSON.parse(candidate.slice(start, i + 1)) as unknown;
        if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as AgentPlan).calls) || typeof (parsed as AgentPlan).message !== "string" || !(parsed as AgentPlan).calls.every(c => c && typeof c.tool === "string" && (c.args === undefined || typeof c.args === "object"))) throw new Error("Reply JSON must have calls[] and message string.");
        return parsed as AgentPlan;
      }
    }
  }
  throw new Error("Could not find a complete JSON plan in the reply.");
}

function args(): { agent: "claude" | "codex" | "both"; scenarios?: string[]; dryRun: boolean } {
  const argv = process.argv.slice(2); let agent: "claude" | "codex" | "both" = "claude", dryRun = false; const selected: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent") { const v = argv[++i]; if (v !== "claude" && v !== "codex" && v !== "both") throw new Error("--agent must be claude, codex, or both"); agent = v; }
    else if (argv[i] === "--scenario") { const v = argv[++i]; if (!v) throw new Error("--scenario requires an id"); selected.push(...v.split(",").map(s => s.trim()).filter(Boolean)); }
    else if (argv[i] === "--dry-run") dryRun = true;
    else throw new Error(`Unknown flag: ${argv[i]}`);
  }
  return { agent, scenarios: selected.length ? selected : undefined, dryRun };
}

export function makePrompt(scenario: Scenario, withSkill: boolean, skillText: string): string {
  const tools = scenario.tools ?? ["agtop_run", "agtop_wait", "agtop_status", "agtop_kill", "agtop_cleanup", "agtop_list", "agtop_harnesses", "agtop_lemonade", "shell"];
  return `You are planning how to handle a user task. PLAN only; do not execute anything.\nAvailable tools: ${tools.join(", ")}. Shell calls use args {"command":"..."}.\n${withSkill ? `Read this skill and follow it:\n--- SKILL.md ---\n${skillText}\n--- end skill ---\n` : ""}${scenario.priorCalls?.length ? `Prior tool calls already happened (transcript):\n${JSON.stringify(scenario.priorCalls, null, 2)}\n` : ""}User task: ${scenario.prompt}\nReply with ONLY a JSON object: {"calls":[{"tool":"...","args":{...}}], "message":"what you'd tell the user"}.`;
}

async function invoke(agent: "claude" | "codex", prompt: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const command = agent === "claude" ? "claude" : "codex";
    const child = spawn(command, agent === "claude" ? ["-p"] : ["exec", "-"], { shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (err?: Error) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(stdout); };
    const timer = setTimeout(() => { child.kill(); finish(new Error("Agent call timed out after 180 seconds.")); }, 180_000);
    child.stdout.setEncoding("utf8").on("data", chunk => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", chunk => stderr += chunk);
    child.on("error", err => finish(new Error(`Could not start ${command}: ${err.message}`)));
    child.on("close", code => code === 0 ? finish() : finish(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`)));
    child.stdin.end(prompt);
  });
}

async function main() {
  const options = args();
  const evalDir = path.resolve("evals/agtop");
  const scenarios = fs.readdirSync(evalDir).filter(f => f.endsWith(".json")).sort().map(file => JSON.parse(fs.readFileSync(path.join(evalDir, file), "utf8")) as Scenario);
  for (const scenario of scenarios) if (!scenario.id || typeof scenario.prompt !== "string" || !validateRules(scenario.rules)) throw new Error(`Invalid scenario: ${scenario.id ?? "unknown"}`);
  const filtered = options.scenarios ? scenarios.filter(s => options.scenarios!.includes(s.id)) : scenarios;
  if (options.scenarios && filtered.length !== new Set(options.scenarios).size) throw new Error(`Unknown scenario id(s): ${options.scenarios.filter(id => !scenarios.some(s => s.id === id)).join(", ")}`);
  const skill = fs.readFileSync(path.resolve("skills/agtop/SKILL.md"), "utf8");
  const agents = options.agent === "both" ? ["claude", "codex"] as const : [options.agent];
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), `agtop-skill-eval-${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  const rows: { scenario: string; agent: string; condition: string; pass: boolean | string; reason: string }[] = [];
  for (const scenario of filtered) for (const agent of agents) for (const withSkill of [true, false]) {
    const condition = withSkill ? "with-skill" : "without-skill", prompt = makePrompt(scenario, withSkill, skill);
    if (options.dryRun) { console.log(`\n=== ${scenario.id} | ${agent} | ${condition} ===\n${prompt}`); continue; }
    let raw = "", pass = false, reason = "";
    try { raw = await invoke(agent, prompt); const plan = parsePlan(raw); const result = gradePlan(scenario.rules, plan); pass = result.pass; reason = result.reasons.join("; ") || "All rules passed."; }
    catch (error) { reason = error instanceof Error ? error.message : String(error); }
    const filename = `${scenario.id}-${agent}-${condition}.txt`; fs.writeFileSync(path.join(rawDir, filename), raw || `[no reply] ${reason}`, "utf8");
    rows.push({ scenario: scenario.id, agent, condition, pass, reason });
  }
  if (options.dryRun) { console.log(`\nDry run: printed ${filtered.length * agents.length * 2} prompts; no agent calls made.`); return; }
  console.table(rows);
  console.log(`Raw replies: ${rawDir}`);
  const untested = new Set(rows.filter(r => r.condition === "without-skill" && r.pass === true).map(r => r.scenario));
  if (untested.size) console.log(`Skill eval warning: passes without-skill (not testing the skill): ${[...untested].join(", ")}`);
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
