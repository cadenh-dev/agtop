import * as fs from "node:fs";
import * as path from "node:path";
import type { GitWorktreeInfo } from "./types.js";

export function resolveGitWorktree(dir?: string): GitWorktreeInfo | undefined {
  if (!dir) return;
  let current = path.resolve(dir);
  while (true) {
    try {
      const dotGit = path.join(current, ".git");
      let gitDir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
        if (!match) throw new Error("Invalid gitdir");
        gitDir = path.resolve(current, match[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      let commonDir = gitDir;
      try { commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()); } catch {}
      return { repoRoot: current, gitDir, commonDir, isWorktree: commonDir !== gitDir,
        branch: head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 8) };
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
