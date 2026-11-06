import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { JobRecord } from "./types.js";

export function stateDir(): string {
  return process.env.AGTOP_STATE_DIR || path.join(process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "agtop");
}
export function validateJobId(id: string): void {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error("Job ID must contain 1–80 letters, digits, underscores, or hyphens.");
}
function recordPath(id: string): string { validateJobId(id); return path.join(stateDir(), `${id}.json`); }
export function reserveJob(id: string): () => void {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const file = recordPath(id);
  const fd = fs.openSync(file, "wx", 0o600);
  fs.closeSync(fd);
  return () => { fs.rmSync(file, { force: true }); };
}
export function writeJob(record: JobRecord): void {
  const file = recordPath(record.jobId);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function readJobs(): JobRecord[] {
  let files: string[];
  try { files = fs.readdirSync(stateDir()); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const records: JobRecord[] = [];
  for (const name of files.filter(n => n.endsWith(".json"))) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(stateDir(), name), "utf8")) as JobRecord;
      validateJobId(r.jobId);
      if (r.version === 1 && name === `${r.jobId}.json` && Number.isSafeInteger(r.rootPid) && r.rootPid > 0 && typeof r.startTime === "string") records.push(r);
    } catch { /* Ignore incomplete reservations and damaged records. */ }
  }
  return records;
}
