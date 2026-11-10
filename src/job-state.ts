import type { JobState, TerminalJobState } from "./types.js";

/** States that never transition again (contracts 14). */
export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>(["exited", "failed", "killed", "lost"]);
/** States counted as "running" by every admission cap (contracts 2.5). */
export const RUNNING_STATES: ReadonlySet<JobState> = new Set<JobState>(["starting", "running", "exiting"]);
/** Exactly the transition table of contracts 14; anything else is a programming error. */
export const LEGAL_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued:   ["starting", "killed", "failed", "lost"],
  starting: ["running", "failed", "lost"],
  running:  ["exiting", "lost"],
  exiting:  ["exited", "killed", "failed", "lost"],
  exited: [], failed: [], killed: [], lost: [],
};

export function isLegalTransition(from: JobState | null, to: JobState): boolean {
  if (from === null) return to === "queued";
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: JobState): state is TerminalJobState {
  return TERMINAL_STATES.has(state);
}
