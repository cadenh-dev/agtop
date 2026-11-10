import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { SecretRedactor } from "../src/redact.js";
import {
  DRAIN_GRACE_MS, FLUSH_TICK_MS, MAX_CHUNK_BYTES, MAX_HOLD_MS, MIN_CHUNK_BYTES,
  PipeStreamReader, pipeCaptureProvider, utf8Boundary,
} from "../src/streams.js";

function capture(source: Readable, options: { redactor?: SecretRedactor; now?: () => number } = {}) {
  const chunks: Buffer[] = [];
  const reader = new PipeStreamReader(source, {
    stream: "stdout",
    redactor: options.redactor ?? null,
    now: options.now,
    onChunk: (data) => chunks.push(Buffer.from(data)),
  });
  return { reader, chunks, output: () => Buffer.concat(chunks) };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await sleep(5);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("PipeStreamReader", () => {
  test("constants match the contract", () => {
    expect([MAX_CHUNK_BYTES, MIN_CHUNK_BYTES, FLUSH_TICK_MS, MAX_HOLD_MS, DRAIN_GRACE_MS])
      .toEqual([65_536, 4_096, 100, 2_000, 2_000]);
  });

  test("utf8Boundary never splits a code point", () => {
    expect(utf8Boundary(Buffer.from("🙂"), 4)).toBe(4);
    expect(utf8Boundary(Buffer.from("🙂"), 3)).toBe(0);
    const mixed = Buffer.from("aé漢");
    expect([utf8Boundary(mixed, 6), utf8Boundary(mixed, 5), utf8Boundary(mixed, 2), utf8Boundary(mixed, 0)])
      .toEqual([6, 3, 1, 0]);
  });

  test("a blocking writer child is captured byte-exact", async () => {
    const script = 'const fs=require("node:fs");const b=Buffer.alloc(65536);for(let i=0;i<b.length;i++)b[i]=(i*31)&255;for(let i=0;i<32;i++)fs.writeSync(1,b);';
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    const { reader, output } = capture(child.stdout!);
    await reader.done;
    const unit = Buffer.alloc(65_536);
    for (let i = 0; i < unit.length; i++) unit[i] = (i * 31) & 0xff;
    const expected = Buffer.concat(Array.from({ length: 32 }, () => unit));
    expect(output().equals(expected)).toBe(true);
    expect(reader.bytesIn).toBe(expected.length);
    expect(reader.bytesOut).toBe(expected.length);
    expect(reader.drained).toBe(true);
  });

  test("multi-byte characters split across reads still yield boundary-aligned chunks", async () => {
    const source = new PassThrough();
    const { reader, chunks, output } = capture(source);
    const text = "aé漢🙂".repeat(1_500);
    const bytes = Buffer.from(text, "utf8");
    for (let i = 0; i < bytes.length; i += 7) source.write(bytes.subarray(i, i + 7));
    source.end();
    await reader.done;
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(utf8Boundary(chunk, chunk.length)).toBe(chunk.length);
    expect(output().equals(bytes)).toBe(true);
    expect(output().toString("utf8")).toBe(text);
  });

  test("a steady 5 ms trickle is visible within 250 ms", async () => {
    const source = new PassThrough();
    const { reader, output } = capture(source);
    source.write("first line\n");
    const interval = setInterval(() => source.write("trickle\n"), 5);
    const started = Date.now();
    await waitFor(() => output().length > 0, 1000);
    expect(Date.now() - started).toBeLessThan(250);
    clearInterval(interval);
    source.end();
    await reader.done;
    expect(output().toString("utf8")).toContain("first line\n");
  });

  test("an unterminated prompt is released after MAX_HOLD_MS", async () => {
    const source = new PassThrough();
    let offset = 0;
    const { reader, chunks, output } = capture(source, { redactor: new SecretRedactor(), now: () => Date.now() + offset });
    source.write("prompt> ");
    await sleep(FLUSH_TICK_MS * 2);
    expect(chunks.length).toBe(0);
    offset = MAX_HOLD_MS + FLUSH_TICK_MS;
    await waitFor(() => chunks.length > 0, FLUSH_TICK_MS + 250);
    expect(output().toString("utf8")).toBe("prompt> ");
    source.end();
    await reader.done;
  });

  test("eof flushes an incomplete trailing code point", async () => {
    const source = new PassThrough();
    const { reader, chunks, output } = capture(source);
    const head = Buffer.from("a".repeat(MIN_CHUNK_BYTES), "ascii");
    const partial = Buffer.from([0xf0, 0x9f]);
    source.write(Buffer.concat([head, partial]));
    source.end();
    await reader.done;
    expect(chunks.length).toBe(2);
    expect(output().equals(Buffer.concat([head, partial]))).toBe(true);
    expect(reader.bytesOut).toBe(MIN_CHUNK_BYTES + 2);
  });

  test("a source that never ends drains after the grace period with drained === false", async () => {
    const source = new PassThrough();
    const { reader, output } = capture(source);
    source.write("still open");
    const started = Date.now();
    reader.notifyExit();
    await reader.done;
    expect(Date.now() - started).toBeGreaterThanOrEqual(DRAIN_GRACE_MS - 50);
    expect(reader.drained).toBe(false);
    expect(output().toString("utf8")).toBe("still open");
  });

  test("redactor null passes bytes through unchanged", async () => {
    const source = new PassThrough();
    const { reader, output } = capture(source);
    const bytes = Buffer.concat([Buffer.from("sk-" + "a".repeat(30)), Buffer.from([0x00, 0xff, 0x0a])]);
    source.write(bytes.subarray(0, 10));
    source.write(bytes.subarray(10));
    source.end();
    await reader.done;
    expect(output().equals(bytes)).toBe(true);
  });

  test("a secret split across two writes is redacted", async () => {
    const source = new PassThrough();
    const { reader, output } = capture(source, { redactor: new SecretRedactor() });
    source.write("key=sk-" + "a".repeat(10));
    await sleep(10);
    source.write("a".repeat(10) + "\n");
    source.end();
    await reader.done;
    expect(output().toString("utf8")).toBe("key=[REDACTED:openai-key]\n");
  });

  test("continuous output past MAX_HOLD_MS still holds back a half-arrived secret", async () => {
    const source = new PassThrough();
    let offset = 0;
    const { reader, output } = capture(source, { redactor: new SecretRedactor(), now: () => Date.now() + offset });
    // Mid-line output keeps the redactor carry non-empty the whole time.
    source.write("x".repeat(3000));
    await sleep(FLUSH_TICK_MS * 2);
    offset = MAX_HOLD_MS + FLUSH_TICK_MS;
    source.write("y".repeat(3000) + " key=sk-" + "a".repeat(10)); // bytes released: the stream is not stalled
    await sleep(FLUSH_TICK_MS * 2);
    source.write("a".repeat(10) + "\n");
    source.end();
    await reader.done;
    const text = output().toString("utf8");
    expect(text).toContain("key=[REDACTED:openai-key]\n");
    expect(text).not.toContain("sk-a");
  });

  test("a slow trickle without newlines never releases a half-arrived secret", async () => {
    const source = new PassThrough();
    let offset = 0;
    const { reader, output } = capture(source, { redactor: new SecretRedactor(), now: () => Date.now() + offset });
    // One byte per 50 ms of (fake) time: never stalled, never fills the 1 KiB holdback.
    for (const char of "x".repeat(38) + "key=sk-" + "a".repeat(25)) {
      source.write(char);
      offset += 50;
      await sleep(5);
    }
    source.write("\n");
    source.end();
    await reader.done;
    const text = output().toString("utf8");
    expect(text).toBe("x".repeat(38) + "key=[REDACTED:openai-key]\n");
  });

  test("a source error finishes the reader with the buffered data", async () => {
    const source = new PassThrough();
    const { reader, output } = capture(source);
    source.write("partial before error");
    await sleep(10);
    source.emit("error", new Error("simulated pipe error"));
    await reader.done;
    expect(output().toString("utf8")).toBe("partial before error");
  });
});

describe("pipeCaptureProvider", () => {
  test("the POSIX provider exposes a pipe session and spawn works on every host", async () => {
    const provider = pipeCaptureProvider("linux");
    expect(provider.kind).toBe("pipe");
    const session = await provider.open("job-posix");
    expect(session.posixStdio()).toEqual(["ignore", "pipe", "pipe"]);
    expect(() => session.windowsHandles()).toThrow();
    expect(() => session.attach()).toThrow();
    session.releaseChildEnds();
    const child = spawn(process.execPath, ["-e", "process.stdout.write('out');process.stderr.write('err')"], {
      stdio: session.posixStdio(),
    });
    const attached = session.attach(child);
    const [stdout, stderr] = await Promise.all([readAll(attached.stdout), readAll(attached.stderr!)]);
    expect(stdout.toString()).toBe("out");
    expect(stderr.toString()).toBe("err");
    session.dispose();
    expect(pipeCaptureProvider().kind).toBe("pipe");
  });
});
