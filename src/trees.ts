import * as os from "node:os";
import { backendFor } from "./backend.js";
import { detectHarness, harnesses } from "./discovery.js";
import { resolveGitWorktree } from "./git.js";
import type { AgentProcessTree, HarnessType, JobRecord, RawOsProcess } from "./types.js";

export function correlateTrees(processes: RawOsProcess[], jobs: JobRecord[], members: Map<string, number[]> = new Map()): AgentProcessTree[] {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const children = new Map<number, RawOsProcess[]>();
  for (const p of processes) {
    const parent = byPid.get(p.ppid);
    // A parent PID can have been reused since its child was born.
    if (parent && BigInt(parent.startTime) > BigInt(p.startTime)) continue;
    children.set(p.ppid, [...(children.get(p.ppid) || []), p]);
  }
  const assigned = new Set<number>();
  const trees: AgentProcessTree[] = [];
  const collect = (root: RawOsProcess) => {
    const result: RawOsProcess[] = [], visited = new Set<number>(), queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      if (visited.has(p.pid) || assigned.has(p.pid)) continue;
      visited.add(p.pid); result.push(p); queue.push(...(children.get(p.pid) || []));
    }
    return result;
  };
  const add = (jobId: string, harness: HarnessType, rootPid: number, procs: RawOsProcess[], record?: JobRecord) => {
    procs = procs.filter(p => !assigned.has(p.pid));
    if (!procs.length) return;
    for (const p of procs) assigned.add(p.pid);
    const root = byPid.get(rootPid) || procs[0];
    const detected = backendFor(procs, harness === "lemonade-server");
    const backend = record?.backend && record.backend !== "unknown" ? record.backend : detected.backend;
    trees.push({ jobId, harness, rootPid, processes: procs, backend,
      backendEvidence: backend === record?.backend && backend !== "unknown" ? "Recorded launch configuration" : detected.evidence,
      userOrPeer: record?.peer || root.envTags?.AGTOP_PEER || os.userInfo().username,
      git: resolveGitWorktree(record?.cwd || root.envTags?.AGTOP_WORKTREE || root.cwd),
      containmentMode: record?.mode || "passive-ppid",
      totalCpuPercent: procs.reduce((sum, p) => sum + p.cpuPercent, 0), totalMemoryMb: procs.reduce((sum, p) => sum + p.memoryMb, 0) });
  };
  for (const job of jobs) {
    const ids = members.get(job.jobId);
    const procs = ids ? ids.map(id => byPid.get(id)).filter((p): p is RawOsProcess => !!p) : [];
    add(job.jobId, job.harness, job.rootPid, procs, job);
  }
  // Tags are attribution hints, not proof of containment or authority to kill a process group.
  const tagged = new Map<string, RawOsProcess[]>();
  for (const p of processes) {
    const id = p.envTags?.AGTOP_JOB_ID;
    if (id && !assigned.has(p.pid)) tagged.set(id, [...(tagged.get(id) || []), p]);
  }
  for (const [id, procs] of tagged) {
    const root = procs.find(p => !procs.some(parent => parent.pid === p.ppid)) || procs[0];
    const harness = root.envTags?.AGTOP_HARNESS as HarnessType;
    add(`unmanaged-${id}`, harnesses.includes(harness) ? harness : "custom", root.pid, procs);
  }
  // Visit ancestors before descendants, independent of PID or scan ordering.
  const depth = (p: RawOsProcess) => {
    let n = 0; const seen = new Set<number>([p.pid]);
    while (byPid.has(p.ppid) && !seen.has(p.ppid)) { p = byPid.get(p.ppid)!; seen.add(p.pid); n++; }
    return n;
  };
  const candidates = processes.filter(p => !assigned.has(p.pid) && detectHarness(p)).sort((a, b) => depth(a) - depth(b) || a.pid - b.pid);
  for (const p of candidates) {
    if (assigned.has(p.pid)) continue;
    const harness = detectHarness(p)!;
    add(`passive-${harness}-${p.pid}`, harness, p.pid, collect(p));
  }
  return trees.sort((a, b) => a.rootPid - b.rootPid);
}
