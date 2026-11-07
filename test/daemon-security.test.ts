import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { startDaemon } from "../src/daemon.js";
import { listAgentTrees, spawnContainedAgent } from "../src/manager.js";

const exec = promisify(execFile);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-daemon-security-"));
const previousStateDir = process.env.AGTOP_STATE_DIR;
process.env.AGTOP_STATE_DIR = path.join(temporary, "state");
const cli = path.resolve("src/cli.ts");
const bodyLimit = 65536;

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR;
  else process.env.AGTOP_STATE_DIR = previousStateDir;
  fs.rmSync(temporary, { recursive: true, force: true });
});

type HttpResult = { status: number; headers: IncomingHttpHeaders; rawHeaders: string[]; body: string };
type Daemon = Awaited<ReturnType<typeof startDaemon>> & { token: string; close: () => Promise<void> };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function nonLoopbackIPv4(): string[] {
  const ips: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      const family = String(addr.family);
      if ((family === "IPv4" || family === "4") && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}
function accessControlAllow(result: HttpResult): string[] {
  const names = new Set<string>();
  for (let i = 0; i < result.rawHeaders.length; i += 2) {
    if (result.rawHeaders[i].toLowerCase().startsWith("access-control-allow-")) names.add(result.rawHeaders[i]);
  }
  for (const name of Object.keys(result.headers)) {
    if (name.toLowerCase().startsWith("access-control-allow-")) names.add(name);
  }
  return [...names];
}
function call(port: number, input: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer; chunks?: Buffer[]; timeoutMs?: number }): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port, method: input.method ?? "GET", path: input.path, headers: input.headers,
    }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.setTimeout(input.timeoutMs ?? 8000, () => req.destroy(new Error(`timed out ${input.method ?? "GET"} ${input.path}`)));
    req.on("error", reject);
    if (input.chunks) { for (const chunk of input.chunks) req.write(chunk); req.end(); }
    else if (input.body !== undefined) req.end(input.body);
    else req.end();
  });
}
function sendRaw(port: number, payload: Buffer, timeoutMs = 8000): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const parts: Buffer[] = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("raw HTTP timed out")); }, timeoutMs);
    socket.on("data", (chunk) => parts.push(chunk));
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("close", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(parts).toString("utf8");
      const splitAt = raw.indexOf("\r\n\r\n");
      const headerText = splitAt === -1 ? raw : raw.slice(0, splitAt);
      const body = splitAt === -1 ? "" : raw.slice(splitAt + 4);
      const headers: IncomingHttpHeaders = {};
      const rawHeaders: string[] = [];
      for (const line of headerText.split("\r\n").slice(1)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        rawHeaders.push(name, value);
        headers[name.toLowerCase()] = value;
      }
      const decoded = /transfer-encoding:\s*chunked/i.test(headerText) ? decodeChunked(body) : body;
      resolve({ status: Number(/^HTTP\/1\.[01] (\d+)/.exec(headerText)?.[1] ?? 0), headers, rawHeaders, body: decoded });
    });
    socket.end(payload);
  });
}
function decodeChunked(body: string): string {
  let rest = body;
  const parts: string[] = [];
  while (rest.length) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd === -1) break;
    const size = Number.parseInt(rest.slice(0, lineEnd).split(";")[0], 16);
    if (!Number.isFinite(size)) break;
    const start = lineEnd + 2;
    if (size === 0) break;
    parts.push(rest.slice(start, start + size));
    rest = rest.slice(start + size + 2);
  }
  return parts.join("");
}
function chunk(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from("\r\n")]);
}
function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
function jsonHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}
async function openDaemon(token?: string): Promise<Daemon> {
  const daemon = await startDaemon({ port: 0, token });
  const stop = daemon.close.bind(daemon);
  let closed = false;
  return Object.assign(daemon, {
    token: fs.readFileSync(daemon.tokenFile, "utf8"),
    close: async () => { if (!closed) { closed = true; await stop(); } },
  });
}
function markerScript(marker: string): string[] {
  return ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
}
function sizedSpawn(size: number, marker: string): Buffer {
  const head = `{"harness":"custom","command":${JSON.stringify(process.execPath)},"args":["-e",${JSON.stringify(markerScript(marker)[1])}],"pad":"`;
  const tail = `"}`;
  const pad = size - Buffer.byteLength(head) - Buffer.byteLength(tail);
  if (pad < 0) throw new Error(`spawn body does not fit in ${size} bytes`);
  return Buffer.from(head + "a".repeat(pad) + tail);
}
async function killIfSpawned(port: number, token: string, response: HttpResult) {
  if (response.status !== 201) return;
  const jobId = (JSON.parse(response.body) as { jobId?: string }).jobId;
  if (!jobId) return;
  await call(port, { method: "POST", path: `/v1/agents/${encodeURIComponent(jobId)}/kill`, headers: jsonHeaders(token), body: "{}", timeoutMs: 25000 }).catch(() => {});
}
function tcp(host: string, port: number, timeoutMs: number): Promise<"connected" | "failed"> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve("failed"); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
    socket.once("error", () => { clearTimeout(timer); resolve("failed"); });
  });
}

test("missing, empty, wrong, and prefix bearer tokens are rejected", async () => {
  const daemon = await openDaemon();
  try {
    const token = daemon.token;
    const flipped = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    const cases: Array<[string, Record<string, string> | undefined]> = [
      ["missing", undefined],
      ["empty header", { authorization: "" }],
      ["Bearer", { authorization: "Bearer" }],
      ["Bearer space", { authorization: "Bearer " }],
      ["lowercase scheme", { authorization: `bearer ${token}` }],
      ["wrong same length", { authorization: `Bearer ${flipped}` }],
      ["token prefix", { authorization: `Bearer ${token.slice(0, -1)}` }],
      ["short prefix", { authorization: `Bearer ${token.slice(0, 8)}` }],
      ["header prefix", { authorization: `Bearer ${token}`.slice(0, -1) }],
    ];
    for (const [label, headers] of cases) {
      const response = await call(daemon.port, { path: "/v1/harnesses", headers });
      expect([label, response.status, response.body]).toEqual([label, 401, expect.stringContaining("Bearer token required")]);
      expect(response.body).not.toContain(token);
    }
    const ok = await call(daemon.port, { path: "/v1/harnesses", headers: bearer(token) });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toContain(token);
    expect(accessControlAllow(ok)).toEqual([]);
  } finally { await daemon.close(); }
}, 15000);

test("a bearer token in the query string is not accepted", async () => {
  const daemon = await openDaemon();
  try {
    const token = daemon.token;
    const paths = [
      `/v1/harnesses?token=${encodeURIComponent(token)}`,
      `/v1/harnesses?access_token=${encodeURIComponent(token)}`,
      `/v1/agents?authorization=${encodeURIComponent(`Bearer ${token}`)}`,
    ];
    for (const requestPath of paths) {
      const response = await call(daemon.port, { path: requestPath });
      expect([requestPath, response.status]).toEqual([requestPath, 401]);
      expect(response.body).not.toContain(token);
    }
    const mixed = await call(daemon.port, {
      path: `/v1/harnesses?token=${encodeURIComponent(token)}`,
      headers: { authorization: `Bearer ${"0".repeat(token.length)}` },
    });
    expect(mixed.status).toBe(401);
  } finally { await daemon.close(); }
}, 15000);

test.skip("timing-safe bearer comparison is not observable over loopback HTTP", () => {
  throw new Error("Equal-length tokens use crypto.timingSafeEqual, but loopback latency hides the comparison.");
});

test("AGTOP_DAEMON_TOKEN shorter than 24 characters is rejected at startup", async () => {
  await expect(startDaemon({ port: 0, token: "x".repeat(23) })).rejects.toThrow("Daemon token must be at least 24 characters.");
  const boundary = await openDaemon("b".repeat(24));
  try {
    expect(boundary.token).toBe("b".repeat(24));
    expect((await call(boundary.port, { path: "/v1/harnesses", headers: bearer(boundary.token) })).status).toBe(200);
  } finally { await boundary.close(); }
  let stderr = "";
  let started = false;
  try {
    await exec(process.execPath, [cli, "daemon", "--port", "0"], {
      env: { ...process.env, AGTOP_DAEMON_TOKEN: "x".repeat(23), AGTOP_STATE_DIR: process.env.AGTOP_STATE_DIR },
      windowsHide: true, timeout: 10000,
    });
    started = true;
  } catch (error) {
    stderr = `${(error as { stderr?: unknown }).stderr ?? ""}`;
  }
  expect(started).toBe(false);
  expect(stderr).toContain("at least 24");
  expect(stderr).not.toContain("Bearer token file");
}, 20000);

test("browser origins are rejected with a valid bearer token", async () => {
  const daemon = await openDaemon();
  try {
    const headers = bearer(daemon.token);
    for (const origin of ["http://evil.example", "null", "chrome-extension://abcdefghijklmnop"]) {
      const response = await call(daemon.port, { path: "/v1/harnesses", headers: { ...headers, origin } });
      expect([origin, response.status, response.body]).toEqual([origin, 401, expect.stringContaining("browser origins")]);
      expect(accessControlAllow(response)).toEqual([]);
    }
    expect((await call(daemon.port, { path: "/v1/harnesses", headers })).status).toBe(200);
  } finally { await daemon.close(); }
}, 15000);

test("accelerator snapshot route uses the daemon auth and origin boundary", async () => {
  const daemon = await openDaemon();
  try {
    expect((await call(daemon.port, { path: "/v1/accelerators" })).status).toBe(401);
    const headers = bearer(daemon.token);
    const browser = await call(daemon.port, { path: "/v1/accelerators", headers: { ...headers, origin: "http://evil.example" } });
    expect(browser.status).toBe(401);
    const response = await call(daemon.port, { path: "/v1/accelerators", headers });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ devices: expect.any(Array), status: expect.any(Array), sampledAt: expect.any(Number) });
  } finally { await daemon.close(); }
}, 15000);

test("OPTIONS preflight grants no Access-Control-Allow-* headers", async () => {
  const daemon = await openDaemon();
  try {
    const preflight = {
      origin: "http://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    };
    const anonymous = await call(daemon.port, { method: "OPTIONS", path: "/v1/agents", headers: preflight });
    const authed = await call(daemon.port, { method: "OPTIONS", path: "/v1/agents", headers: { ...preflight, ...bearer(daemon.token) } });
    const noOrigin = await call(daemon.port, { method: "OPTIONS", path: "/v1/harnesses", headers: { ...bearer(daemon.token), "access-control-request-method": "GET" } });
    expect(anonymous.status).toBe(401);
    expect(authed.status).toBe(401);
    expect(noOrigin.status).toBe(404);
    for (const response of [anonymous, authed, noOrigin]) {
      expect(accessControlAllow(response)).toEqual([]);
      expect(response.rawHeaders.join("\n").toLowerCase()).not.toContain("access-control-allow-");
    }
  } finally { await daemon.close(); }
}, 15000);

test("a 64 KiB body is processed and one extra byte is rejected before spawn", async () => {
  const daemon = await openDaemon();
  const marker = path.join(temporary, "oversize-spawn");
  try {
    const exact = Buffer.alloc(bodyLimit, 0x20);
    exact[0] = 0x7b;
    const accepted = await call(daemon.port, { method: "POST", path: "/v1/agents", headers: jsonHeaders(daemon.token), body: exact });
    expect(accepted.status).toBe(400);
    expect(accepted.body).not.toContain("64 KiB");
    expect(accepted.body).toContain("JSON");
    const oversized = sizedSpawn(bodyLimit + 1, marker);
    expect(oversized.length).toBe(bodyLimit + 1);
    const rejected = await call(daemon.port, { method: "POST", path: "/v1/agents", headers: jsonHeaders(daemon.token), body: oversized });
    await killIfSpawned(daemon.port, daemon.token, rejected);
    expect(rejected.status).toBe(400);
    expect(JSON.parse(rejected.body)).toEqual({ error: "Request body exceeds 64 KiB." });
    expect(fs.existsSync(marker)).toBe(false);
  } finally { await daemon.close(); }
}, 15000);

test("a chunked body over 64 KiB is rejected and an exact chunked body is processed", async () => {
  const daemon = await openDaemon();
  const marker = path.join(temporary, "chunked-spawn");
  try {
    const head = Buffer.from([
      "POST /v1/agents HTTP/1.1",
      "Host: 127.0.0.1",
      `Authorization: Bearer ${daemon.token}`,
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "Connection: close",
      "",
      "",
    ].join("\r\n"));
    const exactBody = Buffer.alloc(bodyLimit, 0x20);
    exactBody[0] = 0x7b;
    const exact = await sendRaw(daemon.port, Buffer.concat([
      head, chunk(exactBody.subarray(0, 32768)), chunk(exactBody.subarray(32768)), Buffer.from("0\r\n\r\n"),
    ]));
    expect(exact.status).toBe(400);
    expect(exact.body).not.toContain("64 KiB");
    expect(exact.body).toContain("JSON");
    const oversized = sizedSpawn(bodyLimit + 1, marker);
    const rejected = await sendRaw(daemon.port, Buffer.concat([
      head, chunk(oversized.subarray(0, 40000)), chunk(oversized.subarray(40000)), Buffer.from("0\r\n\r\n"),
    ]));
    await killIfSpawned(daemon.port, daemon.token, rejected);
    expect(rejected.status).toBe(400);
    expect(JSON.parse(rejected.body)).toEqual({ error: "Request body exceeds 64 KiB." });
    expect(fs.existsSync(marker)).toBe(false);
  } finally { await daemon.close(); }
}, 15000);

test("invalid JSON cannot spawn an agent", async () => {
  const daemon = await openDaemon();
  const marker = path.join(temporary, "invalid-json-spawn");
  try {
    for (const body of ["{", "{]", "{\"harness\":", "not json", `${JSON.stringify({ harness: "custom", command: process.execPath, args: markerScript(marker) }).slice(0, -1)}`]) {
      const response = await call(daemon.port, { method: "POST", path: "/v1/agents", headers: jsonHeaders(daemon.token), body });
      await killIfSpawned(daemon.port, daemon.token, response);
      expect(response.status).toBe(400);
      expect(response.body).toContain("JSON");
      expect(fs.existsSync(marker)).toBe(false);
    }
  } finally { await daemon.close(); }
}, 15000);

test("a wrong content-type cannot authorize a spawn", async () => {
  const daemon = await openDaemon();
  const marker = path.join(temporary, "content-type-spawn");
  const spawnBody = JSON.stringify({ harness: "custom", command: process.execPath, args: markerScript(marker) });
  try {
    const unauthenticated = await call(daemon.port, {
      method: "POST", path: "/v1/agents", headers: { "content-type": "text/plain" }, body: spawnBody,
    });
    const crossOrigin = await call(daemon.port, {
      method: "POST", path: "/v1/agents",
      headers: { ...bearer(daemon.token), origin: "http://evil.example", "content-type": "text/plain" },
      body: spawnBody,
    });
    const formRequest = await call(daemon.port, {
      method: "POST", path: "/v1/agents",
      headers: { ...bearer(daemon.token), "content-type": "application/x-www-form-urlencoded" },
      body: `harness=custom&command=${encodeURIComponent(process.execPath)}&args=${encodeURIComponent(JSON.stringify(markerScript(marker)))}`,
    });
    const plain = await call(daemon.port, {
      method: "POST", path: "/v1/agents",
      headers: { ...bearer(daemon.token), "content-type": "text/plain" },
      body: "this is not json",
    });
    for (const response of [unauthenticated, crossOrigin, formRequest, plain]) await killIfSpawned(daemon.port, daemon.token, response);
    expect(unauthenticated.status).toBe(401);
    expect(crossOrigin.status).toBe(401);
    expect(formRequest.status).toBe(400);
    expect(plain.status).toBe(400);
    expect(fs.existsSync(marker)).toBe(false);
  } finally { await daemon.close(); }
}, 15000);

test("unknown routes and wrong methods are 404", async () => {
  const daemon = await openDaemon();
  try {
    const headers = bearer(daemon.token);
    const cases: Array<[string, string]> = [
      ["GET", "/v1/no-such"],
      ["GET", "/v1/agents/extra"],
      ["POST", "/v1/harnesses"],
      ["DELETE", "/v1/agents"],
      ["PUT", "/v1/harnesses"],
      ["GET", "/v1/agents/job/kill"],
      ["PATCH", "/v1/agents"],
    ];
    for (const [method, requestPath] of cases) {
      const response = await call(daemon.port, { method, path: requestPath, headers });
      expect([method, requestPath, response.status, response.body]).toEqual([method, requestPath, 404, expect.stringContaining("Route not found")]);
    }
  } finally { await daemon.close(); }
}, 15000);

test("kill rejects unknown ids and encoded traversal or NUL bytes", async () => {
  const daemon = await openDaemon();
  const sentinel = path.join(temporary, "traversal-sentinel");
  fs.writeFileSync(sentinel, "keep");
  const job = await spawnContainedAgent({ harness: "custom", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
  try {
    const headers = jsonHeaders(daemon.token);
    const attacks = [
      "/v1/agents/..%2F/kill",
      "/v1/agents/..%2F..%2Fetc%2Fpasswd/kill",
      "/v1/agents/%2e%2e%2f%2e%2e%2f/kill",
      "/v1/agents/%00/kill",
      `/v1/agents/${job.jobId}%00/kill`,
      `/v1/agents/%00${job.jobId}/kill`,
      "/v1/agents/..%5C..%5CWindows/kill",
    ];
    for (const requestPath of attacks) {
      const response = await call(daemon.port, { method: "POST", path: requestPath, headers, body: "{}", timeoutMs: 25000 });
      expect([requestPath, response.status]).toEqual([requestPath, 400]);
      expect(response.body).toContain("not found");
      expect(alive(job.pid)).toBe(true);
    }
    const unknown = await call(daemon.port, { method: "POST", path: "/v1/agents/no-such-daemon-job/kill", headers, body: "{}", timeoutMs: 25000 });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toContain("not found");
    expect(unknown.body).toContain("no-such-daemon-job");
    expect(alive(job.pid)).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    expect((await listAgentTrees()).some(tree => tree.jobId === job.jobId)).toBe(true);
  } finally {
    await job.terminate().catch(() => {});
    await job.exited.catch(() => {});
    await daemon.close();
  }
}, 60000);

test("spawn rejects a missing command and non-array arguments", async () => {
  const daemon = await openDaemon();
  const marker = path.join(temporary, "bad-spawn");
  try {
    const headers = jsonHeaders(daemon.token);
    const cases = [
      ["missing command", { harness: "custom", args: markerScript(marker) }],
      ["empty command", { harness: "custom", command: "", args: markerScript(marker) }],
      ["args string", { harness: "custom", command: process.execPath, args: "-e" }],
      ["args object", { harness: "custom", command: process.execPath, args: { 0: "-e" } }],
      ["args numbers", { harness: "custom", command: process.execPath, args: [1, 2] }],
      ["traversal job id", { harness: "custom", command: process.execPath, args: markerScript(marker), jobId: "../escape" }],
    ];
    for (const [label, body] of cases) {
      const response = await call(daemon.port, { method: "POST", path: "/v1/agents", headers, body: JSON.stringify(body) });
      await killIfSpawned(daemon.port, daemon.token, response);
      expect([label, response.status]).toEqual([label, 400]);
      expect(response.status).not.toBe(201);
      expect(fs.existsSync(marker)).toBe(false);
    }
  } finally { await daemon.close(); }
}, 15000);

const lanAddresses = nonLoopbackIPv4();
test.skipIf(lanAddresses.length === 0)("the daemon accepts connections only on 127.0.0.1", async () => {
  const daemon = await openDaemon();
  try {
    expect(await tcp("127.0.0.1", daemon.port, 1000)).toBe("connected");
    for (const host of lanAddresses) expect([host, await tcp(host, daemon.port, 1000)]).toEqual([host, "failed"]);
  } finally { await daemon.close(); }
}, 20000);

test.skipIf(process.platform === "win32")("the POSIX token file mode is 0600", async () => {
  const daemon = await openDaemon();
  try { expect(fs.statSync(daemon.tokenFile).mode & 0o777).toBe(0o600); }
  finally { await daemon.close(); }
}, 15000);

test("graceful shutdown kills only jobs created by that daemon", async () => {
  const external = await spawnContainedAgent({ harness: "custom", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
  const daemon = await openDaemon();
  let ownedPid: number | undefined;
  try {
    const response = await call(daemon.port, {
      method: "POST", path: "/v1/agents", headers: jsonHeaders(daemon.token),
      body: JSON.stringify({ harness: "custom", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }),
    });
    expect(response.status).toBe(201);
    const owned = JSON.parse(response.body) as { jobId: string; pid: number };
    ownedPid = owned.pid;
    expect(alive(external.pid)).toBe(true);
    expect(alive(owned.pid)).toBe(true);
    await daemon.close();
    expect(alive(external.pid)).toBe(true);
    expect(alive(owned.pid)).toBe(false);
    const trees = await listAgentTrees();
    expect(trees.some(tree => tree.jobId === external.jobId)).toBe(true);
    expect(trees.some(tree => tree.jobId === owned.jobId)).toBe(false);
    expect(fs.existsSync(path.join(process.env.AGTOP_STATE_DIR!, `${external.jobId}.json`))).toBe(true);
  } finally {
    await daemon.close();
    if (ownedPid !== undefined && alive(ownedPid)) { try { process.kill(ownedPid); } catch { /* already gone */ } }
    await external.terminate().catch(() => {});
    await external.exited.catch(() => {});
  }
}, 60000);
