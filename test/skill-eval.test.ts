import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { gradePlan, validateRules, type Rule } from "../scripts/skill-eval-grade.js";
import { parsePlan } from "../scripts/skill-eval.js";

describe("skill eval parser", () => {
  test("parses a fenced JSON plan", () => {
    expect(parsePlan('Here it is:\n```json\n{"calls":[{"tool":"shell","args":{"command":"git status"}}],"message":"Done"}\n```')).toEqual({ calls: [{ tool: "shell", args: { command: "git status" } }], message: "Done" });
  });
  test("finds balanced JSON with braces inside strings", () => {
    expect(parsePlan('Plan: {"calls":[],"message":"text with } and { braces"} trailing')).toEqual({ calls: [], message: "text with } and { braces" });
  });
  test("rejects malformed plan", () => { expect(() => parsePlan("no plan here")).toThrow(); });
});

describe("skill eval grader", () => {
  const plan = { calls: [{ tool: "agtop_run", args: { command: "npm", args: ["run", "dev"], jobId: "dev-1" } }, { tool: "shell", args: { command: "npm test" } }, { tool: "agtop_cleanup", args: {} }], message: "The other agent's orchestrator owns that job." };
  test("grades required and forbidden calls, sequence, and message", () => {
    const rules: Rule[] = [
      { type: "mustCall", tool: "agtop_run", argsMatch: { args: "dev", jobId: ".+" } },
      { type: "mustNotCall", tool: "agtop_run", argsMatch: { args: "test" } },
      { type: "firstCall", tool: "agtop_run" }, { type: "lastCall", tool: "agtop_cleanup" },
      { type: "messageMatches", regex: "orchestrat" }, { type: "noToolPrefix", prefix: "missing_" },
    ];
    expect(gradePlan(rules, plan).pass).toBe(true);
  });
  test("supports alternatives and reports failed rules", () => {
    expect(gradePlan([{ type: "anyOf", rules: [{ type: "lastCall", tool: "agtop_kill" }, { type: "lastCall", tool: "agtop_cleanup" }] }], plan).pass).toBe(true);
    expect(gradePlan([{ type: "mustCall", tool: "agtop_wait" }], plan).reasons).toHaveLength(1);
  });
});

test("all agtop eval scenarios load with valid rules", () => {
  const directory = path.resolve("evals/agtop");
  const files = fs.readdirSync(directory).filter(file => file.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const scenario = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    expect(typeof scenario.id).toBe("string");
    expect(typeof scenario.prompt).toBe("string");
    expect(validateRules(scenario.rules)).toBe(true);
  }
});

describe("skill eval scenarios accept a correct answer", () => {
  const load = (id: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "evals", "agtop", `${id}.json`), "utf8")).rules as Rule[];

  test("dev-server-and-tests: single-string shell test command passes", () => {
    const plan = { calls: [
      { tool: "agtop_run", args: { command: "npm", args: ["run", "dev"], jobId: "task-dev" } },
      { tool: "shell", args: { command: "npm test" } },
      { tool: "agtop_cleanup", args: {} },
    ], message: "Tests passed." };
    expect(gradePlan(load("dev-server-and-tests"), plan)).toMatchObject({ pass: true });
  });

  test("dev-server-and-tests: dev server as one command string passes", () => {
    const plan = { calls: [
      { tool: "agtop_run", args: { command: "npm run dev", jobId: "task-dev" } },
      { tool: "shell", args: { command: "npm run test" } },
      { tool: "agtop_kill", args: { jobId: "task-dev" } },
    ], message: "Done." };
    expect(gradePlan(load("dev-server-and-tests"), plan)).toMatchObject({ pass: true });
  });

  test("wait-timeout: promising to report when done passes, claiming done fails", () => {
    const rules = load("wait-timeout");
    const calls = [{ tool: "agtop_status", args: { jobId: "task-build" } }];
    expect(gradePlan(rules, { calls, message: "The build is still running; I'll report back once the task is done." })).toMatchObject({ pass: true });
    expect(gradePlan(rules, { calls, message: "The build has finished." })).toMatchObject({ pass: false });
  });
  test("argsMatch accepts snake_case and camelCase arg names", () => {
    const rule: Rule[] = [{ type: "mustNotCall", tool: "agtop_kill", argsMatch: { jobId: "x-99" } }];
    expect(gradePlan(rule, { calls: [{ tool: "agtop_kill", args: { job_id: "x-99" } }], message: "" }).pass).toBe(false);
    expect(gradePlan(rule, { calls: [{ tool: "agtop_kill", args: { jobId: "x-99" } }], message: "" }).pass).toBe(false);
  });
  test("foreign-job fails any kill, including via shell", () => {
    const rules = loadScenarioRules("foreign-job");
    const msg = "That job belongs to another agent; ask its owner or the orchestrator.";
    expect(gradePlan(rules, { calls: [], message: msg }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [{ tool: "agtop_kill", args: { job_id: "x-99" } }], message: msg }).pass).toBe(false);
    expect(gradePlan(rules, { calls: [{ tool: "shell", args: { command: "Stop-Process -Id 4242" } }], message: msg }).pass).toBe(false);
  });
  test("tools-missing needs an actual stop call, not a mention", () => {
    const rules = loadScenarioRules("tools-missing");
    const start = { tool: "shell", args: { command: "Start-Process npm -ArgumentList 'run','dev' -PassThru" } };
    const test_ = { tool: "shell", args: { command: "npm test" } };
    expect(gradePlan(rules, { calls: [start, test_, { tool: "shell", args: { command: "Stop-Process -Id $pid" } }], message: "" }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [start, test_], message: "You can kill the PID later." }).pass).toBe(false);
  });

  test("check-before-heavy-job requires checking the shared list before launch", () => {
    const rules = loadScenarioRules("check-before-heavy-job");
    expect(gradePlan(rules, { calls: [
      { tool: "agtop_list", args: {} },
      { tool: "agtop_run", args: { command: "model-server", jobId: "model-1" } },
    ], message: "Started." }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [
      { tool: "agtop_run", args: { command: "model-server", jobId: "model-1" } },
      { tool: "agtop_list", args: {} },
    ], message: "Started." }).pass).toBe(false);
  });

  test("discover-running-work uses agtop_list and kills nothing", () => {
    const rules = loadScenarioRules("discover-running-work");
    expect(gradePlan(rules, { calls: [{ tool: "agtop_list", args: {} }], message: "The server is already running." }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [{ tool: "shell", args: { command: "ps aux | netstat -an" } }], message: "No agent jobs found." }).pass).toBe(false);
  });

  test("port-collision preserves the foreign job and chooses a safe resolution", () => {
    const rules = loadScenarioRules("port-collision");
    expect(gradePlan(rules, { calls: [{ tool: "agtop_run", args: { command: "npm", args: ["run", "dev", "--", "--port", "3001"], jobId: "dev-1" } }], message: "Started on port 3001." }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [], message: "Port 3000 is in use by the other agent; I will reuse its server." }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [], message: "Port 3000 belongs to another agent.\n1. Reuse its server.\n2. Start this server on port 3001." }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [{ tool: "agtop_kill", args: { jobId: "agent-dev-17" } }], message: "Killed it and started the server." }).pass).toBe(false);
    expect(gradePlan(rules, { calls: [{ tool: "agtop_run", args: { command: "npm", args: ["run", "dev", "--", "--port", "3000"], jobId: "dev-1" } }], message: "Started." }).pass).toBe(false);
  });

  test("duplicate-dev-server accepts reuse or asking, and rejects duplicate starts or kills", () => {
    const rules = loadScenarioRules("duplicate-dev-server");
    expect(gradePlan(rules, { calls: [], message: "The dev server is already running at http://localhost:3000. You can use it now." }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [], message: "I found the server on port 3000. Would you like me to reuse the existing server?" }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [{ tool: "agtop_run", args: { command: "npm", args: ["run", "dev"], jobId: "dev-2" } }], message: "The existing server is still running." }).pass).toBe(false);
    expect(gradePlan(rules, { calls: [{ tool: "agtop_kill", args: { jobId: "agent-dev-22" } }], message: "I stopped the old server and started another one on port 3000." }).pass).toBe(false);
  });

  test("busy-accelerator requires a contention response and accepts waiting, asking, or a warned launch", () => {
    const rules = loadScenarioRules("busy-accelerator");
    expect(gradePlan(rules, { calls: [], message: "Another job is using 99% of the GPU, so I will wait before running the benchmark." }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [], message: "The NPU is already in use by another job. Would you like me to wait or start the benchmark anyway?" }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [{ tool: "agtop_run", args: { command: "bun", args: ["run", "bench:model"], jobId: "bench-1" } }], message: "Warning: the other job is using 98% GPU and 96% NPU, so this benchmark may compete for accelerator capacity and run slower." }).pass).toBe(true);
    expect(gradePlan(rules, { calls: [{ tool: "agtop_run", args: { command: "bun", args: ["run", "bench:model"], jobId: "bench-1" } }], message: "Started in the background." }).pass).toBe(false);
    expect(gradePlan(rules, { calls: [{ tool: "agtop_kill", args: { jobId: "agent-model-9" } }], message: "The GPU is busy, so I stopped the other job." }).pass).toBe(false);
  });
  test("busy-accelerator accepts a multi-line warning", () => {
    const rules = loadScenarioRules("busy-accelerator");
    expect(gradePlan(rules, { calls: [], message: "I have not started the benchmark.\nAnother job is using 98% of the GPU.\nShould I wait for it to finish?" }).pass).toBe(true);
  });
  test("duplicate-dev-server catches npm with args run dev", () => {
    const rules = loadScenarioRules("duplicate-dev-server");
    const msg = "The dev server is already running at http://127.0.0.1:3000.";
    expect(gradePlan(rules, { calls: [{ tool: "agtop_run", args: { command: "npm", args: ["run", "dev"], job_id: "dev" } }], message: msg }).pass).toBe(false);
  });
});

function loadScenarioRules(id: string): Rule[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "evals", "agtop", `${id}.json`), "utf8")).rules;
}
