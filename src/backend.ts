import type { Backend, RawOsProcess } from "./types.js";

export function backendFor(processes: RawOsProcess[], localEngine = false): { backend: Backend; evidence: string } {
  if (localEngine) return { backend: "local-engine", evidence: "Local server executable" };
  for (const p of processes) {
    const env = p.envTags || {};
    if (env.AGTOP_BACKEND === "amd-lemonade-local") return { backend: "amd-lemonade-local", evidence: "Explicit launch configuration" };
    for (const key of ["OPENAI_API_BASE", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"]) {
      try {
        const url = new URL(env[key]);
        if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.port === "13305") return { backend: "amd-lemonade-local", evidence: `${key} points to local port 13305` };
        if (["api.openai.com", "api.anthropic.com"].includes(url.hostname)) return { backend: "cloud-api", evidence: `${key} points to a known cloud endpoint` };
      } catch {}
    }
  }
  return { backend: "unknown", evidence: "No observable endpoint configuration" };
}
export function lemonadeBase(raw = "http://127.0.0.1:13305"): string {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("Lemonade URL must be an HTTP(S) base URL without credentials, query, or fragment.");
  u.pathname = u.pathname.replace(/\/$/, "");
  return u.toString().replace(/\/$/, "");
}
export interface LemonadeStatus { reachable: boolean; url: string; loadedModels: string[]; availableModels: string[]; error?: string }
export async function probeLemonade(base = "http://127.0.0.1:13305", timeoutMs = 1200): Promise<LemonadeStatus> {
  const url = lemonadeBase(base);
  const result: LemonadeStatus = { reachable: false, url, loadedModels: [], availableModels: [] };
  const request = async (suffix: string) => {
    const response = await fetch(`${url}${suffix}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<Record<string, any>>;
  };
  for (const prefix of ["/v1", "/api/v1"]) {
    try {
      const [health, models] = await Promise.allSettled([request(`${prefix}/health`), request(`${prefix}/models`)]);
      if (health.status === "fulfilled") {
        result.reachable = true;
        const h = health.value;
        result.loadedModels = Array.isArray(h.all_models_loaded) ? h.all_models_loaded.map((m: any) => typeof m === "string" ? m : m.model_name).filter((m: unknown) => typeof m === "string") : typeof h.model_loaded === "string" ? [h.model_loaded] : [];
      }
      if (models.status === "fulfilled") {
        result.reachable = true;
        result.availableModels = Array.isArray(models.value.data) ? models.value.data.map((m: any) => m.id).filter((m: unknown) => typeof m === "string") : [];
      }
      if (result.reachable) return result;
      result.error = health.status === "rejected" ? String(health.reason) : "No supported endpoint";
    } catch (e) { result.error = String(e); }
  }
  return result;
}
