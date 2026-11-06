import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { spawnContainedAgent } from "../src/manager.js";
import { findByMarker, killByMarker } from "./process-probe.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-ab-"));
process.env.AGTOP_STATE_DIR = stateDir;

const parentScript = "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)',process.argv[1]],{detached:true,stdio:'ignore'}).unref();";
const longScript = `${parentScript}setInterval(()=>{},1000)`;
const markers = new Set<string>();
let counter = 0;
const unique = (label: string) => `AGTOP_AB_${label}_${Date.now()}_${counter++}`;

function marker(label: string): string {
  const value = unique(label);
  markers.add(value);
  return value;
}

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await delay(100);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for the grandchild.`);
}

interface Row {
  scenario: string;
  leaked: number;
  expected: number;
  pass: boolean;
}

const rows: Row[] = [];
try {
  // Baseline: an ordinary detached grandchild survives its parent.
  const baseline = marker("baseline");
  const direct = spawn(process.execPath, ["-e", parentScript, baseline], { stdio: "ignore" });
  const [directCode] = await once(direct, "exit");
  await delay(1000);
  const baselineLeaked = findByMarker(baseline).length;
  rows.push({ scenario: "direct spawn (no containment)", leaked: baselineLeaked, expected: 1, pass: directCode === 0 && baselineLeaked >= 1 });
  killByMarker(baseline);

  // Managed normal exit: the Job Object/cgroup finalizer reaps the grandchild.
  const normal = marker("normal");
  const normalAgent = await spawnContainedAgent({
    jobId: unique("ab-normal"),
    harness: "custom",
    command: process.execPath,
    args: ["-e", parentScript, normal],
    stdio: "ignore",
    userOrPeer: "ab-test",
  });
  const normalCode = await normalAgent.exited;
  await delay(1000);
  const normalLeaked = findByMarker(normal).length;
  rows.push({ scenario: "agtop normal exit", leaked: normalLeaked, expected: 0, pass: normalCode === 0 && normalLeaked === 0 });

  // Managed cancellation: terminate while both parent and grandchild are alive.
  const cancelled = marker("cancelled");
  const cancelAgent = await spawnContainedAgent({
    jobId: unique("ab-cancel"),
    harness: "custom",
    command: process.execPath,
    args: ["-e", longScript, cancelled],
    stdio: "ignore",
    userOrPeer: "ab-test",
  });
  await waitFor(() => findByMarker(cancelled).length >= 2);
  const result = await cancelAgent.terminate();
  await cancelAgent.exited;
  await delay(500);
  const cancelLeaked = findByMarker(cancelled).length;
  rows.push({
    scenario: "agtop terminate",
    leaked: cancelLeaked,
    expected: 0,
    pass: result.failedPids.length === 0 && result.errors.length === 0 && cancelLeaked === 0,
  });

  console.table(rows);
  const failed = rows.filter(row => !row.pass);
  if (failed.length) {
    console.error(`FAIL ${failed.length}/${rows.length} containment scenarios.`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${rows.length}/${rows.length} containment scenarios.`);
  }
} finally {
  for (const value of markers) killByMarker(value);
  fs.rmSync(stateDir, { recursive: true, force: true });
}
