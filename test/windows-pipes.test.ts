import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import type { Readable } from "node:stream";
import koffi from "koffi";
import { PipeStreamReader } from "../src/streams.js";
import { windowsApi } from "../src/windows.js";
import { openWindowsPipeSession, windowsPipeCaptureProvider } from "../src/windows-pipes.js";

type NativeProcess = ReturnType<ReturnType<typeof windowsApi>["launch"]>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function capture(source: Readable, stream: "stdout" | "stderr") {
  const chunks: Buffer[] = [];
  const reader = new PipeStreamReader(source, {
    stream, redactor: null, onChunk: (data) => chunks.push(Buffer.from(data)),
  });
  return { reader, output: () => Buffer.concat(chunks) };
}

async function waitExit(child: NativeProcess, timeoutMs = 30_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    const code = child.poll();
    if (code !== undefined) return code;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the child to exit.");
    await sleep(10);
  }
}

/** Verifies that a failed open closed its named-pipe servers: the name accepts a new instance.
 *  Polls because libuv closes pipe servers asynchronously (slow on loaded CI runners). */
async function canListen(name: string, timeoutMs = 2000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(name, () => server.close(() => resolve(true)));
    });
    if (ok) return true;
    await sleep(25);
  }
  return false;
}

function handleCounter(): () => number {
  const lib = koffi.load("kernel32.dll");
  const getCount = lib.func("int __stdcall GetProcessHandleCount(void *process, _Out_ uint32 *count)");
  const getCurrentProcess = lib.func("void * __stdcall GetCurrentProcess()");
  return () => { const count = [0]; getCount(getCurrentProcess(), count); return count[0]; };
}

const windowsOnly = describe.skipIf(process.platform !== "win32");

windowsOnly("windowsPipeCaptureProvider", () => {
  test("captures stdout and stderr separately, delivers EOF and preserves the exit code", async () => {
    const provider = windowsPipeCaptureProvider();
    expect(provider.kind).toBe("pipe");
    const jobId = `win-pipes-${randomUUID()}`;
    const jobName = `Local\\agtop-test-${randomUUID()}`;
    const script = "const fs=require('node:fs');"
      + "const out=Buffer.alloc(131072);for(let i=0;i<out.length;i++)out[i]=(i*131+7)&255;"
      + "const err=Buffer.alloc(20000);for(let i=0;i<err.length;i++)err[i]=(i*17+3)&255;"
      + "fs.writeSync(1,out);fs.writeSync(2,err);process.exit(7);";
    const expectedOut = Buffer.alloc(131072);
    for (let i = 0; i < expectedOut.length; i++) expectedOut[i] = (i * 131 + 7) & 0xff;
    const expectedErr = Buffer.alloc(20000);
    for (let i = 0; i < expectedErr.length; i++) expectedErr[i] = (i * 17 + 3) & 0xff;
    const session = await provider.open(jobId);
    expect(() => session.posixStdio()).toThrow();
    let child: NativeProcess | undefined;
    try {
      child = windowsApi().launch(jobName, process.execPath, ["-e", script], process.cwd(),
        process.env as Record<string, string>, session.windowsHandles());
      // JOB_LIST assigns containment during creation, before this suspended process ever runs.
      const members = windowsApi().withJob(jobName, 4, (job) => windowsApi().pids(job)) ?? [];
      expect(members).toContain(child.pid);
      // Unit 2.4 order: launch, attach, release the parent's child-side ends, then resume.
      const attached = session.attach();
      expect(attached.stderr).not.toBeNull();
      const out = capture(attached.stdout, "stdout");
      const err = capture(attached.stderr!, "stderr");
      session.releaseChildEnds();
      child.resume();
      const code = await waitExit(child);
      // EOF must arrive from the closed handles, not from notifyExit().
      await Promise.all([out.reader.done, err.reader.done]);
      expect(code).toBe(7);
      expect(out.reader.drained).toBe(true);
      expect(err.reader.drained).toBe(true);
      expect(out.reader.bytesIn).toBe(expectedOut.length);
      expect(err.reader.bytesIn).toBe(expectedErr.length);
      expect(out.output().equals(expectedOut)).toBe(true);
      expect(err.output().equals(expectedErr)).toBe(true);
    } finally {
      child?.close();
      session.dispose();
    }
  }, 60_000);

  test("a busy pipe fails closed with capture-error and leaves no servers or handles behind", async () => {
    const jobId = `win-busy-${randomUUID()}`;
    const nonce = randomUUID();
    const countHandles = handleCounter();
    countHandles(); // Initialize Koffi's lazy state before the baseline.
    const before = countHandles();
    let firstFailure = "";
    // Simulates another process holding the only pipe instance: CreateFileW returns ERROR_PIPE_BUSY.
    const openClient = (name: string, access: number, open: (name: string, access: number) => unknown) => {
      if (access === 0x40000000) throw new Error("simulated ERROR_PIPE_BUSY (231)");
      return open(name, access);
    };
    for (let i = 0; i < 20; i++) {
      try {
        await openWindowsPipeSession(jobId, { nonce, openClient });
      } catch (error) {
        firstFailure ||= String(error);
      }
    }
    await sleep(50);
    expect(firstFailure).toContain("capture-error");
    expect(firstFailure).not.toContain(jobId);
    expect(firstFailure).not.toContain("\\\\.\\pipe");
    // A leaked NUL handle from the partial open would grow by one per failed attempt.
    expect(countHandles() - before).toBeLessThanOrEqual(4);
    expect(await canListen(`\\\\.\\pipe\\agtop-${jobId}-stdout-${nonce}`)).toBe(true);
    expect(await canListen(`\\\\.\\pipe\\agtop-${jobId}-stderr-${nonce}`)).toBe(true);
  }, 60_000);

  test("a real CreateFileW failure fails closed with capture-error and leaks no handle", async () => {
    const jobId = `win-missing-${randomUUID()}`;
    const nonce = randomUUID();
    const countHandles = handleCounter();
    countHandles(); // Initialize Koffi's lazy state before the baseline.
    const before = countHandles();
    let failure = "";
    try {
      await openWindowsPipeSession(jobId, {
        nonce,
        // Force the real native call for the already-opened NUL handle, then aim stdout at an absent pipe.
        openClient: (name, access, open) => open(access === 0x40000000 ? `${name}-absent` : name, access),
      });
    } catch (error) {
      failure = String(error);
    }
    await sleep(50);
    expect(failure).toContain("capture-error");
    expect(failure).toContain("Win32 error");
    expect(failure).not.toContain(jobId);
    expect(countHandles() - before).toBeLessThanOrEqual(2);
    expect(await canListen(`\\\\.\\pipe\\agtop-${jobId}-stdout-${nonce}`)).toBe(true);
    expect(await canListen(`\\\\.\\pipe\\agtop-${jobId}-stderr-${nonce}`)).toBe(true);
  }, 60_000);

  test("a failed client open leaves no timer behind that could reject later", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      let failure = "";
      try {
        await openWindowsPipeSession(`win-openfail-${randomUUID()}`, {
          connectTimeoutMs: 100,
          openClient: (name, access, open) => open(access === 0x40000000 ? `${name}-absent` : name, access),
        });
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain("capture-error");
      await sleep(400); // well past connectTimeoutMs
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 60_000);

  test("a pipe connection that never arrives times out with capture-error and frees the names", async () => {
    const jobId = `win-noconnect-${randomUUID()}`;
    const nonce = randomUUID();
    let failure = "";
    try {
      await openWindowsPipeSession(jobId, {
        nonce, connectTimeoutMs: 200,
        // Valid handles that never connect to the pipe servers.
        openClient: (name, access, open) => open(access === 0x40000000 ? "NUL" : name, access),
      });
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain("capture-error");
    expect(failure).toContain("timed out");
    expect(failure).not.toContain(jobId);
    expect(await canListen(`\\\\.\\pipe\\agtop-${jobId}-stdout-${nonce}`)).toBe(true);
    expect(await canListen(`\\\\.\\pipe\\agtop-${jobId}-stderr-${nonce}`)).toBe(true);
  }, 60_000);

  test("50 open/launch/release/dispose cycles do not leak handles", async () => {
    const provider = windowsPipeCaptureProvider();
    const countHandles = handleCounter();
    const cycle = async (): Promise<void> => {
      const session = await provider.open(`win-cycle-${randomUUID()}`);
      let child: NativeProcess | undefined;
      try {
        child = windowsApi().launch(`Local\\agtop-test-${randomUUID()}`, process.execPath,
          ["-e", "process.exit(0)"], process.cwd(), process.env as Record<string, string>, session.windowsHandles());
        const attached = session.attach();
        const out = capture(attached.stdout, "stdout");
        const err = capture(attached.stderr!, "stderr");
        session.releaseChildEnds();
        child.resume();
        expect(await waitExit(child)).toBe(0);
        await Promise.all([out.reader.done, err.reader.done]);
      } finally {
        child?.close();
        session.dispose();
      }
    };
    countHandles(); // Initialize Koffi's lazy state before the baseline.
    await cycle(); // Warm up the event loop and libuv pipe bookkeeping.
    const before = countHandles();
    for (let i = 0; i < 50; i++) await cycle();
    await sleep(100);
    expect(countHandles() - before).toBeLessThanOrEqual(16);
  }, 180_000);
});
