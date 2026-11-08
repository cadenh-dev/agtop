export type ToolCall = { tool: string; args?: Record<string, unknown> };
export type Rule =
  | { type: "mustCall" | "mustNotCall"; tool: string; argsMatch?: Record<string, string> }
  | { type: "firstCall"; tool?: string; tools?: string[] }
  | { type: "lastCall"; tool: string; argsMatch?: Record<string, string> }
  | { type: "messageMatches" | "messageNotMatches"; regex: string }
  | { type: "noToolPrefix"; prefix: string }
  | { type: "anyOf"; rules: Rule[] }
  | { type: "callsOrMessageMatches"; regex: string };

export interface AgentPlan { calls: ToolCall[]; message: string }
export interface GradeResult { pass: boolean; reasons: string[] }

// Agents spell arg names either way (jobId vs job_id), so look up both.
function argValue(args: Record<string, unknown> | undefined, key: string): unknown {
  const snake = key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
  const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return args?.[key] ?? args?.[snake] ?? args?.[camel];
}

function matches(call: ToolCall | undefined, rule: { tool: string; argsMatch?: Record<string, string> }): boolean {
  if (!call || call.tool !== rule.tool) return false;
  return Object.entries(rule.argsMatch ?? {}).every(([key, pattern]) => {
    try { return new RegExp(pattern, "i").test(JSON.stringify(argValue(call.args, key))); }
    catch { return false; }
  });
}

export function validateRules(rules: unknown): rules is Rule[] {
  if (!Array.isArray(rules)) return false;
  return rules.every((rule) => {
    if (!rule || typeof rule !== "object" || typeof rule.type !== "string") return false;
    switch (rule.type) {
      case "mustCall": case "mustNotCall": return typeof rule.tool === "string" && (rule.argsMatch === undefined || (typeof rule.argsMatch === "object" && Object.values(rule.argsMatch).every(v => typeof v === "string")));
      case "firstCall": return typeof rule.tool === "string" || (Array.isArray(rule.tools) && rule.tools.length > 0 && rule.tools.every((v: unknown) => typeof v === "string"));
      case "lastCall": return typeof rule.tool === "string" && (rule.argsMatch === undefined || (typeof rule.argsMatch === "object" && Object.values(rule.argsMatch).every(v => typeof v === "string")));
      case "messageMatches": case "messageNotMatches": case "callsOrMessageMatches": return typeof rule.regex === "string";
      case "noToolPrefix": return typeof rule.prefix === "string";
      case "anyOf": return Array.isArray(rule.rules) && rule.rules.length > 0 && validateRules(rule.rules);
      default: return false;
    }
  });
}

function check(rule: Rule, plan: AgentPlan): string | undefined {
  const calls = plan.calls;
  switch (rule.type) {
    case "mustCall": return calls.some(c => matches(c, rule)) ? undefined : `Expected ${rule.tool} call${rule.argsMatch ? ` matching ${JSON.stringify(rule.argsMatch)}` : ""}.`;
    case "mustNotCall": return calls.some(c => matches(c, rule)) ? `Unexpected ${rule.tool} call${rule.argsMatch ? ` matching ${JSON.stringify(rule.argsMatch)}` : ""}.` : undefined;
    case "firstCall": return (rule.tool ? calls[0]?.tool === rule.tool : rule.tools?.includes(calls[0]?.tool ?? "")) ? undefined : `First call must be ${rule.tool ?? rule.tools?.join(" or ") ?? "specified tool"}.`;
    case "lastCall": return matches(calls.at(-1), rule) ? undefined : `Last call must be ${rule.tool}${rule.argsMatch ? ` matching ${JSON.stringify(rule.argsMatch)}` : ""}.`;
    case "messageMatches": return new RegExp(rule.regex, "i").test(plan.message) ? undefined : `Message did not match /${rule.regex}/.`;
    case "messageNotMatches": return new RegExp(rule.regex, "i").test(plan.message) ? `Message unexpectedly matched /${rule.regex}/.` : undefined;
    case "noToolPrefix": return calls.some(c => c.tool.startsWith(rule.prefix)) ? `No call may use the ${rule.prefix} prefix.` : undefined;
    case "callsOrMessageMatches": return calls.some(c => new RegExp(rule.regex, "i").test(JSON.stringify(c))) || new RegExp(rule.regex, "i").test(plan.message) ? undefined : `Calls or message did not match /${rule.regex}/.`;
    case "anyOf": return rule.rules.some(r => !check(r, plan)) ? undefined : `None of the alternative rules passed: ${rule.rules.map(r => check(r, plan)).join("; ")}`;
  }
}

export function gradePlan(rules: Rule[], plan: AgentPlan): GradeResult {
  const reasons = rules.map(rule => check(rule, plan)).filter((reason): reason is string => !!reason);
  return { pass: reasons.length === 0, reasons };
}
