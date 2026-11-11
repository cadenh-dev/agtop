---
name: agtop
description: Use when starting a process that may outlive the current turn or task, such as a dev server, watcher, test runner, or subagent, or anything launched through a shell that may exit first. Not for short commands whose output you need to read.
---

# agtop task containment

agtop gives a task its own OS containment unit: a Windows Job Object, a Linux cgroup, or a Linux or macOS process group with inherited tags. Use it when a command may outlive the turn, when you spawn a subagent, or when an intermediate shell may exit. Do not use it for short commands whose stdout you need: "run" captures stdout and stderr into a bounded buffer that "output" reads; with capture set to false it discards output.

The MCP server exposes short tool names. OpenCode exposes them as `agtop_run`, `agtop_wait`, `agtop_status`, `agtop_output`, `agtop_events`, `agtop_kill`, `agtop_cleanup`, `agtop_list`, `agtop_harnesses`, and `agtop_lemonade`; other clients namespace them similarly.

## Workflow

1. Search for the harness if you do not know its ID:
   - `agtop_harnesses { "query": "codex" }`
2. Start the task with a stable task ID:
   - `agtop_run { "command": "codex", "args": ["exec", "..."], "cwd": "/path/to/worktree", "harness": "codex", "jobId": "task-123", "peer": "my-task" }`
3. Wait for it when you need the exit code:
   - `agtop_wait { "jobId": "task-123", "timeoutMs": 60000 }`
4. Read what it printed when you need the output:
   - `agtop_output { "jobId": "task-123", "tail": 100 }`
   - `agtop_output { "jobId": "task-123", "since": 918, "format": "json" }` to page forward with `nextSince`.
   - `agtop_events { "jobId": "task-123" }` shows the queue, start, exit, port lease, and admission timeline.
5. Inspect while it runs; `status` shows each process's role, listening ports, and measured GPU/NPU usage for jobs owned by this MCP session:
   - `agtop_status { "jobId": "task-123", "includeProcesses": true }`
6. Stop it when you are done:
   - `agtop_kill { "jobId": "task-123" }`
   - or `agtop_cleanup {}` to stop every job this session created.

## Queueing

- `run` is immediate by default and is never queued. Passing `priority`, `dependsOn`, `leasePorts`, or `resources` queues the job behind admission rules.
- A queued `run` result has `state: "queued"`, `pid` absent, and `queue: { position, blockedBy }`. `wait` on it times out with `state: "queued"`; `kill` cancels it.
- Use `leasePorts` when the job will bind ports, `resources` for GPU, NPU, or memory, and `dependsOn` for jobs that must succeed first.
- Output is readable at `agtop://jobs/{jobId}/output/{stream}` and the lifecycle timeline at `agtop://jobs/{jobId}/events`; each page's `nextUri` pages forward.

## Multi-agent awareness

- Before heavy or port-binding work, check `agtop_list`; it shows shared jobs, peers, ports, and CPU, memory, GPU, and NPU totals.
- Reuse or wait for an equivalent job another agent already runs instead of starting a duplicate.
- If another job is using nearly all GPU/NPU capacity, tell the user and wait, ask, or launch another heavy job only with an explicit contention warning.
- If another agent's job holds a needed port or resource, never kill it; choose another port, reuse the job, or tell the user/orchestrator.
- Prefer `agtop_list` over shell `ps` or `netstat` to discover agent jobs.

## Rules

- Always pass a task-specific `jobId`; treat it as the task ID. Use `peer` to label the task or tenant.
- `kill` only accepts jobs created by this MCP session. Do not try to kill other agents' live jobs; use your own orchestrator for that. MCP `cleanup` may remove records only when agtop proves the supervisor and all contained members are gone.
- Call `agtop_cleanup` before finishing any task that started helpers, even if you expect them to have exited.
- If `wait` times out, the job is still running. Inspect it and decide whether to kill it; do not assume it finished.
- Use the normal shell for commands whose output you need once; `agtop_output` reads the output `agtop_run` captured for a long-lived job.
- agtop is lifecycle containment, not a security sandbox. It does not restrict filesystem, network, memory, or privileges.
- If the agtop tools are unavailable, fall back to the normal shell, but explicitly track and stop the PIDs you start.

## Examples

Contain a dev server and a watcher, then clean up:

```text
agtop_run { "command": "npm", "args": ["run", "dev"], "cwd": "/work/app", "jobId": "task-dev-server", "peer": "task-42" }
agtop_run { "command": "npm", "args": ["run", "watch"], "cwd": "/work/app", "jobId": "task-watcher", "peer": "task-42" }
... work ...
agtop_cleanup {}
```

Contain a subagent tree:

```text
agtop_run { "command": "codex", "args": ["exec", "fix the failing tests"], "cwd": "/work/app", "harness": "codex", "jobId": "task-subagent-1", "peer": "task-42" }
agtop_wait { "jobId": "task-subagent-1", "timeoutMs": 600000 }
agtop_status { "jobId": "task-subagent-1", "includeProcesses": true }
```
