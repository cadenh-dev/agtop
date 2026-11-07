import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { signalLinuxProcess } from "../src/linux.js";

test.skipIf(process.platform !== "linux")("pidfd termination rechecks identity after opening the pidfd", async () => {
  const order: string[] = [];
  const fd = fs.openSync("/dev/null", "r");
  const result = await signalLinuxProcess(12345, "old-instance", 9, {
    open: () => { order.push("open"); return fd; },
    send: () => { order.push("send"); return 0; },
  }, async () => { order.push("identity"); return "reused-instance"; });
  expect(result).toBe("reused");
  expect(order).toEqual(["open", "identity"]);
});
