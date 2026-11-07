import * as fs from "node:fs";
import { scanLinuxProcesses } from "./discovery.js";
import { signalLinuxProcess } from "./linux.js";

const pgid = Number(process.argv[2]);
const jobId = process.argv[3];
if (!Number.isSafeInteger(pgid) || pgid <= 0 || !jobId) process.exit(2);

// fd 3 is held open by the manager. EOF means the manager exited, including
// an uncatchable crash, so this watchdog owns final fallback cleanup.
const byte = Buffer.alloc(1);
try { while (fs.readSync(3, byte, 0, 1, null) > 0) {} } catch { /* Treat a broken pipe as manager death. */ }

let quietScans = 0;
while (quietScans < 4) {
  const processes = await scanLinuxProcesses();
  const targets = processes.filter(p => p.pid !== process.pid && (p.pgid === pgid || p.envTags?.AGTOP_JOB_ID === jobId));
  if (!targets.length) quietScans++;
  else {
    quietScans = 0;
    await Promise.all(targets.map(async p => {
      try { await signalLinuxProcess(p.pid, p.startTime, 9); } catch { /* Exit or permission race; retry on next scan. */ }
    }));
  }
  if (quietScans < 4) await new Promise(resolve => setTimeout(resolve, 100));
}
