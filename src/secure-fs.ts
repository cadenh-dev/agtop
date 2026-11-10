import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/** Directories hardened once per process, keyed by resolved path. */
const HARDENED_DIRS = new Set<string>();

/** mkdir -p with mode 0700; chmod 0700 on POSIX; hardenWindowsAcl once per directory per process on Windows. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const key = path.resolve(dir);
    if (HARDENED_DIRS.has(key)) return;
    HARDENED_DIRS.add(key);
    hardenWindowsAcl(dir);
    return;
  }
  fs.chmodSync(dir, 0o700);
}

/** Write to "<file>.<pid>.tmp" with mode 0600, then rename over file. */
export function writePrivateFileAtomic(file: string, data: string | Buffer): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* The temp file may already be gone; the original error is the one that matters. */
    }
    throw error;
  }
}

/** open(file, "wx", 0600), write, close. Returns false on EEXIST; rethrows anything else. */
export function createPrivateFileExclusive(file: string, data: string | Buffer): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** POSIX: throws if (mode & 0o077) !== 0 or the owner is not the current uid. Windows: no-op. */
export function assertPrivateFile(file: string): void {
  if (process.platform === "win32") return;
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) throw new Error(`File is accessible by other users: ${file}`);
  if (stat.uid !== process.getuid?.()) throw new Error(`File is owned by another user: ${file}`);
}

/** Windows only; returns { ok: true } elsewhere. Never throws. */
export function hardenWindowsAcl(target: string): { ok: boolean; message?: string } {
  if (process.platform !== "win32") return { ok: true };
  try {
    const rights = fs.statSync(target).isDirectory() ? "(OI)(CI)F" : "F";
    const domain = process.env.USERDOMAIN;
    const name = process.env.USERNAME;
    const user = domain && name ? `${domain}\\${name}` : os.userInfo().username;
    execFileSync("icacls.exe", [target, "/inheritance:r", "/grant:r", `${user}:${rights}`], {
      windowsHide: true,
      timeout: 5000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
