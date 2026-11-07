import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveGitWorktree } from "../src/git.js";

function withTempDir(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-git-test-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeGitDir(gitDir: string, head: string): void {
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), head);
}

function writeRepoAt(repoRoot: string, head: string): void {
  writeGitDir(path.join(repoRoot, ".git"), head);
}

const gitOnPath = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

describe("resolveGitWorktree", () => {
  test("returns undefined when dir is omitted or empty", () => {
    expect(resolveGitWorktree()).toBeUndefined();
    expect(resolveGitWorktree("")).toBeUndefined();
  });

  test("returns undefined for non-existent cwd (walks up without throwing)", () => {
    const missing = path.join(os.tmpdir(), `agtop-missing-${Date.now()}-${Math.random()}`);
    expect(fs.existsSync(missing)).toBe(false);
    expect(() => resolveGitWorktree(missing)).not.toThrow();
    expect(resolveGitWorktree(missing)).toBeUndefined();
  });

  test("normal repo at root resolves branch and paths", () => {
    withTempDir((root) => {
      writeRepoAt(root, "ref: refs/heads/main\n");
      const info = resolveGitWorktree(root);
      expect(info).toMatchObject({
        repoRoot: root,
        branch: "main",
        isWorktree: false,
      });
      expect(path.normalize(info!.gitDir)).toBe(path.normalize(path.join(root, ".git")));
      expect(path.normalize(info!.commonDir)).toBe(path.normalize(info!.gitDir));
    });
  });

  test("nested working directory resolves same repo", () => {
    withTempDir((root) => {
      writeRepoAt(root, "ref: refs/heads/develop\n");
      const nested = path.join(root, "packages", "app", "src");
      fs.mkdirSync(nested, { recursive: true });
      expect(resolveGitWorktree(nested)).toMatchObject({
        repoRoot: root,
        branch: "develop",
        isWorktree: false,
      });
    });
  });

  test("branch names containing slashes", () => {
    withTempDir((root) => {
      writeRepoAt(root, "ref: refs/heads/feature/agents/v2\n");
      expect(resolveGitWorktree(root)?.branch).toBe("feature/agents/v2");
    });
  });

  test("detached HEAD uses first eight characters of commit sha", () => {
    withTempDir((root) => {
      writeRepoAt(root, "deadbeef0123456789abcdef0123456789abcdef\n");
      expect(resolveGitWorktree(root)).toMatchObject({
        repoRoot: root,
        branch: "deadbeef",
        isWorktree: false,
      });
    });
  });

  test("linked worktree with relative gitdir and commondir", () => {
    withTempDir((root) => {
      writeRepoAt(root, "ref: refs/heads/main\n");
      const wt = path.join(root, "linked-wt");
      const admin = path.join(root, ".git", "worktrees", "linked-wt");
      fs.mkdirSync(wt);
      fs.mkdirSync(admin, { recursive: true });
      fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../.git/worktrees/linked-wt\n");
      fs.writeFileSync(path.join(admin, "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
      fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
      const info = resolveGitWorktree(wt);
      expect(info).toMatchObject({
        repoRoot: wt,
        branch: "01234567",
        isWorktree: true,
      });
      expect(path.normalize(info!.gitDir)).toBe(path.normalize(admin));
      expect(path.normalize(info!.commonDir)).toBe(path.normalize(path.join(root, ".git")));
    });
  });

  test("linked worktree with absolute gitdir path", () => {
    withTempDir((root) => {
      writeRepoAt(root, "ref: refs/heads/main\n");
      const wt = path.join(root, "abs-wt");
      const admin = path.join(root, ".git", "worktrees", "abs-wt");
      fs.mkdirSync(wt);
      fs.mkdirSync(admin, { recursive: true });
      const absAdmin = path.resolve(admin);
      fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${absAdmin.replace(/\\/g, "/")}\n`);
      fs.writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/worktree-branch\n");
      fs.writeFileSync(path.join(admin, "commondir"), path.join(root, ".git").replace(/\\/g, "/") + "\n");
      const info = resolveGitWorktree(wt);
      expect(info).toMatchObject({
        repoRoot: wt,
        branch: "worktree-branch",
        isWorktree: true,
      });
    });
  });

  test("worktree admin without commondir is not flagged as linked worktree", () => {
    withTempDir((root) => {
      writeRepoAt(root, "ref: refs/heads/main\n");
      const wt = path.join(root, "plain-wt");
      const admin = path.join(root, ".git", "worktrees", "plain-wt");
      fs.mkdirSync(wt);
      fs.mkdirSync(admin, { recursive: true });
      fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../.git/worktrees/plain-wt\n");
      fs.writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/main\n");
      const info = resolveGitWorktree(wt);
      expect(info?.isWorktree).toBe(false);
      expect(info?.branch).toBe("main");
    });
  });

  test("submodule layout via gitdir into parent .git/modules", () => {
    withTempDir((root) => {
      writeRepoAt(root, "ref: refs/heads/superproject\n");
      const subRoot = path.join(root, "vendor", "lib");
      const subGit = path.join(root, ".git", "modules", "vendor", "lib");
      fs.mkdirSync(subRoot, { recursive: true });
      writeGitDir(subGit, "ref: refs/heads/sub-detached\n");
      fs.writeFileSync(path.join(subRoot, ".git"), "gitdir: ../../.git/modules/vendor/lib\n");
      const info = resolveGitWorktree(subRoot);
      expect(info).toMatchObject({
        repoRoot: subRoot,
        branch: "sub-detached",
        isWorktree: false,
      });
      expect(path.normalize(info!.gitDir)).toBe(path.normalize(subGit));
    });
  });

  test("bare repository directory and plain tree without .git return undefined", () => {
    withTempDir((root) => {
      const bare = path.join(root, "bare.git");
      writeGitDir(bare, "ref: refs/heads/bare-main\n");
      fs.writeFileSync(path.join(bare, "config"), "[core]\n\tbare = true\n");
      expect(resolveGitWorktree(bare)).toBeUndefined();

      const plain = path.join(root, "plain");
      fs.mkdirSync(plain);
      fs.writeFileSync(path.join(plain, "readme.txt"), "no git\n");
      expect(resolveGitWorktree(plain)).toBeUndefined();
    });
  });

  test("malformed .git file and missing HEAD do not throw", () => {
    withTempDir((root) => {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, ".git"), "not a gitdir line\n");
      expect(() => resolveGitWorktree(root)).not.toThrow();
      expect(resolveGitWorktree(root)).toBeUndefined();

      const noHead = path.join(root, "no-head");
      fs.mkdirSync(noHead, { recursive: true });
      fs.mkdirSync(path.join(noHead, ".git"));
      expect(() => resolveGitWorktree(noHead)).not.toThrow();
      expect(resolveGitWorktree(noHead)).toBeUndefined();
    });
  });

  test("Windows-style backslashes in gitdir line", () => {
    withTempDir((root) => {
      writeRepoAt(root, "ref: refs/heads/main\n");
      const wt = path.join(root, "win-wt");
      const admin = path.join(root, ".git", "worktrees", "win-wt");
      fs.mkdirSync(wt);
      fs.mkdirSync(admin, { recursive: true });
      const rel = path.relative(wt, admin);
      fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${rel}\n`);
      fs.writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/win-branch\n");
      const info = resolveGitWorktree(wt);
      expect(info).toMatchObject({ repoRoot: wt, branch: "win-branch" });
      expect(path.normalize(info!.gitDir)).toBe(path.normalize(admin));
    });
  });

  test("nested repository inside another resolves the nearest (inner) repo", () => {
    withTempDir((root) => {
      writeRepoAt(root, "ref: refs/heads/outer\n");
      const inner = path.join(root, "nested", "inner");
      fs.mkdirSync(inner, { recursive: true });
      writeRepoAt(inner, "ref: refs/heads/inner\n");
      const deep = path.join(inner, "src", "lib");
      fs.mkdirSync(deep, { recursive: true });
      expect(resolveGitWorktree(deep)).toMatchObject({
        repoRoot: inner,
        branch: "inner",
      });
      expect(resolveGitWorktree(root)).toMatchObject({
        repoRoot: root,
        branch: "outer",
      });
    });
  });

  test.skipIf(!gitOnPath)("real git: worktree add matches hand-built attribution", () => {
    withTempDir((root) => {
      const r = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
      expect(r.status).toBe(0);
      spawnSync("git", ["commit", "--allow-empty", "-m", "init"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" },
      });
      const wt = path.join(root, "real-wt");
      const add = spawnSync("git", ["worktree", "add", wt, "-b", "wt/real"], { cwd: root, encoding: "utf8" });
      expect(add.status).toBe(0);
      expect(resolveGitWorktree(wt)).toMatchObject({
        repoRoot: wt,
        branch: "wt/real",
      });
      expect(resolveGitWorktree(wt)?.isWorktree).toBe(true);
    });
  });

});

function localSubmoduleAddWorks(): boolean {
  if (!gitOnPath) return false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-git-probe-"));
  try {
    const parent = path.join(root, "parent");
    const sub = path.join(root, "sub");
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.com",
    };
    spawnSync("git", ["init", "-b", "main"], { cwd: sub });
    spawnSync("git", ["commit", "--allow-empty", "-m", "s"], { cwd: sub, env });
    spawnSync("git", ["init", "-b", "main"], { cwd: parent });
    spawnSync("git", ["commit", "--allow-empty", "-m", "p"], { cwd: parent, env });
    const add = spawnSync("git", ["-C", parent, "submodule", "add", pathToFileURL(sub).href, "modules/sub"], {
      encoding: "utf8",
      env,
    });
    return add.status === 0;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const submoduleAddWorks = localSubmoduleAddWorks();

describe("resolveGitWorktree (real git submodule)", () => {
  test.skipIf(!submoduleAddWorks)("real git: submodule add layout", () => {
    withTempDir((root) => {
      const parent = path.join(root, "parent");
      const sub = path.join(root, "sub");
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t.com",
      };
      spawnSync("git", ["init", "-b", "main"], { cwd: sub });
      spawnSync("git", ["commit", "--allow-empty", "-m", "s"], { cwd: sub, env });
      spawnSync("git", ["init", "-b", "main"], { cwd: parent });
      spawnSync("git", ["commit", "--allow-empty", "-m", "p"], { cwd: parent, env });
      const add = spawnSync("git", ["-C", parent, "submodule", "add", pathToFileURL(sub).href, "modules/sub"], {
        encoding: "utf8",
        env,
      });
      expect(add.status).toBe(0);
      const subPath = path.join(parent, "modules", "sub");
      expect(resolveGitWorktree(subPath)).toMatchObject({ repoRoot: subPath, branch: "main" });
    });
  });
});
