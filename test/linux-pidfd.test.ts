import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { signalLinuxProcess } from "../src/linux.js";

test.skipIf(process.platform !== "linux")("pidfd termination rechecks identity after opening the pidfd", async () => {
  const order: string[] = [];
  const fd = fs.openSync("/dev/null", "r");
  const result = await signalLinuxProcess(12345, "old-instance", 9, {
    open: (_pid, flags) => { order.push(`open:${flags}`); return fd; },
    send: (_fd, _signal, info, flags) => { order.push(`send:${info}:${flags}`); return 0; },
  }, async () => { order.push("identity"); return "reused-instance"; });
  expect(result).toBe("reused");
  expect(order).toEqual(["open:0", "identity"]);
});

test.skipIf(process.platform !== "linux")("pidfd calls pass zero flags and a null siginfo pointer", async () => {
  const fd = fs.openSync("/dev/null", "r");
  let args: unknown[] = [];
  const result = await signalLinuxProcess(12345, "same-instance", 9, {
    open: (_pid, flags) => { expect(flags).toBe(0); return fd; },
    send: (...values) => { args = values; return 0; },
  }, async () => "same-instance");
  expect(result).toBe("pidfd");
  expect(args).toEqual([fd, 9, null, 0]);
});
