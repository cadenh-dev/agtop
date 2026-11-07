import { describe, expect, test } from "bun:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { backendFor, lemonadeBase, probeLemonade } from "../src/backend.js";
import type { RawOsProcess } from "../src/types.js";

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

function proc(pid = 1): RawOsProcess {
  return { pid, ppid: 0, name: "node", cmdline: "node", startTime: "1", cpuSeconds: 0, cpuPercent: 0, memoryMb: 1 };
}

async function listen(
  handler: RouteHandler,
  host = "127.0.0.1",
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind ephemeral port");
  return {
    url: `http://${host}:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function lemonadeRoutes(
  overrides: Partial<Record<"/v1/health" | "/v1/models" | "/api/v1/health" | "/api/v1/models", RouteHandler>>,
  defaults?: {
    health?: Record<string, unknown>;
    models?: Record<string, unknown>;
  },
): RouteHandler {
  const health = defaults?.health ?? { status: "ok", all_models_loaded: [{ model_name: "loaded-a" }] };
  const models = defaults?.models ?? { data: [{ id: "avail-a" }, { id: "loaded-a" }] };
  const serve = (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url?.split("?")[0] ?? "";
    const key = path as keyof typeof overrides;
    if (overrides[key]) return overrides[key]!(req, res);
    if (path === "/v1/health" || path === "/api/v1/health") return json(res, 200, health);
    if (path === "/v1/models" || path === "/api/v1/models") return json(res, 200, models);
    json(res, 404, {});
  };
  return serve;
}

describe("lemonadeBase", () => {
  test("strips trailing slashes and rejects credentials in URL", () => {
    expect(lemonadeBase("http://127.0.0.1:13305/")).toBe("http://127.0.0.1:13305");
    expect(lemonadeBase("http://127.0.0.1:9/custom/")).toBe("http://127.0.0.1:9/custom");
    expect(() => lemonadeBase("http://user:pass@127.0.0.1:9")).toThrow(/without credentials/);
  });
});

describe("probeLemonade", () => {
  test("healthy server reports loaded and available models separately", async () => {
    const fake = await listen(
      lemonadeRoutes({}, {
        health: { status: "ok", model_loaded: "only-loaded" },
        models: { data: [{ id: "m1" }, { id: "m2" }] },
      }),
    );
    try {
      const status = await probeLemonade(fake.url);
      expect(status).toMatchObject({
        reachable: true,
        url: fake.url,
        loadedModels: ["only-loaded"],
        availableModels: ["m1", "m2"],
      });
    } finally {
      await fake.close();
    }
  });

  test("falls back from /v1 to /api/v1 when /v1 endpoints are missing", async () => {
    const fake = await listen((req, res) => {
      const path = req.url?.split("?")[0] ?? "";
      if (path.startsWith("/v1/")) {
        json(res, 404, { error: "not found" });
        return;
      }
      if (path === "/api/v1/health") {
        json(res, 200, { status: "ok", all_models_loaded: ["from-api"] });
        return;
      }
      if (path === "/api/v1/models") {
        json(res, 200, { data: [{ id: "api-model" }] });
        return;
      }
      json(res, 404, {});
    });
    try {
      const status = await probeLemonade(fake.url);
      expect(status.reachable).toBe(true);
      expect(status.loadedModels).toEqual(["from-api"]);
      expect(status.availableModels).toEqual(["api-model"]);
    } finally {
      await fake.close();
    }
  });

  test("reports HTTP 401 and 403 auth rejection clearly", async () => {
    for (const code of [401, 403] as const) {
      const server = await listen((_req, res) => json(res, code, { error: "unauthorized" }));
      try {
        const status = await probeLemonade(server.url);
        expect(status.reachable).toBe(false);
        expect(status.error).toContain(`HTTP ${code}`);
      } finally {
        await server.close();
      }
    }
  });

  test("malformed JSON leaves server unreachable with an error", async () => {
    const fake = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{not-json");
    });
    try {
      const status = await probeLemonade(fake.url);
      expect(status.reachable).toBe(false);
      expect(status.error).toBeTruthy();
    } finally {
      await fake.close();
    }
  });

  test("times out slow responses within the configured bound", async () => {
    const delayMs = 400;
    const timeoutMs = 80;
    const fake = await listen((_req, res) => {
      setTimeout(() => json(res, 200, { status: "ok", all_models_loaded: [] }), delayMs);
    });
    try {
      const start = performance.now();
      const status = await probeLemonade(fake.url, timeoutMs);
      const elapsed = performance.now() - start;
      expect(status.reachable).toBe(false);
      // Two prefix attempts (/v1 and /api/v1), each waiting for parallel health+models timeouts.
      expect(elapsed).toBeLessThan(timeoutMs * 4 + 400);
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 20);
      expect(status.error).toMatch(/TimeoutError|timed out|abort/i);
    } finally {
      await fake.close();
    }
  });

  test("does not follow 3xx redirects", async () => {
    const fake = await listen((req, res) => {
      const p = req.url?.split("?")[0] ?? "";
      if (p.endsWith("/health") || p.endsWith("/models")) {
        res.writeHead(302, { Location: "/elsewhere" });
        res.end();
        return;
      }
      json(res, 404, {});
    });
    try {
      const status = await probeLemonade(fake.url);
      expect(status.reachable).toBe(false);
      expect(status.error?.toLowerCase()).toMatch(/redirect|fetch failed/i);
    } finally {
      await fake.close();
    }
  });

  test("connection refused on closed port", async () => {
    const fake = await listen((_req, res) => json(res, 200, {}));
    const base = fake.url;
    await fake.close();
    const status = await probeLemonade(base, 500);
    expect(status.reachable).toBe(false);
    expect(status.error).toBeTruthy();
  });

  test("honors custom base URL with trailing slash", async () => {
    const fake = await listen(
      lemonadeRoutes(
        {},
        {
          health: { status: "ok", all_models_loaded: ["x"] },
          models: { data: [{ id: "y" }] },
        },
      ),
    );
    try {
      const status = await probeLemonade(`${fake.url}/`);
      expect(status.url).toBe(fake.url);
      expect(status.reachable).toBe(true);
    } finally {
      await fake.close();
    }
  });
});

describe("backendFor lemonade evidence", () => {
  const withEnv = (env: Record<string, string>) => [{ ...proc(), envTags: env }];

  test("port 13305 on loopback hosts yields amd-lemonade-local with endpoint evidence", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"] as const) {
      const url = `http://${host}:13305/v1`;
      const result = backendFor(withEnv({ OPENAI_BASE_URL: url }));
      expect(result).toEqual({
        backend: "amd-lemonade-local",
        evidence: "OPENAI_BASE_URL points to local port 13305",
      });
    }
  });

  test("explicit AGTOP_BACKEND option takes precedence", () => {
    expect(backendFor(withEnv({ AGTOP_BACKEND: "amd-lemonade-local" }))).toEqual({
      backend: "amd-lemonade-local",
      evidence: "Explicit launch configuration",
    });
  });

  test("no observable Lemonade routing stays unknown", () => {
    expect(backendFor(withEnv({ OPENAI_BASE_URL: "http://127.0.0.1:9999/v1" }))).toEqual({
      backend: "unknown",
      evidence: "No observable endpoint configuration",
    });
    expect(backendFor([])).toEqual({
      backend: "unknown",
      evidence: "No observable endpoint configuration",
    });
  });
});

describe("run --lemonade environment", () => {
  test.skip("Lemonade launch env assembly is not exported; OPENAI_API_KEY / ANTHROPIC_API_KEY are not assigned in spawnContainedAgent", () => {
    // manager.ts only sets OPENAI_BASE_URL, OPENAI_API_BASE, ANTHROPIC_BASE_URL, and AGTOP_BACKEND when useLemonadeLocal is true.
  });
});
