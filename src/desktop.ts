import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./daemon.js";

/** Start a private daemon for this desktop session and clean up when its window exits. */
export async function launchDesktop(binary?: string): Promise<void> {
  const filename = process.platform === "win32" ? "agtop-desktop.exe" : "agtop-desktop";
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = binary ? [path.resolve(binary)] : [
    process.env.AGTOP_DESKTOP_BINARY,
    path.join(path.dirname(process.execPath), filename),
    path.join(here, filename),
    path.resolve(here, "../dist", filename),
    path.resolve(here, "../desktop/target/debug", filename),
    path.resolve(process.cwd(), "dist", filename),
  ].filter((p): p is string => !!p);
  const executable = candidates.find(p => fs.existsSync(p));
  if (!executable) throw new Error("Desktop executable not found. Run bun run desktop:build first, or set AGTOP_DESKTOP_BINARY.");
  const daemon = await startDaemon({ port: 0 });
  // This is the user-requested interactive window; SW_HIDE would hide GPUI's first window.
  const child = spawn(executable, ["--port", String(daemon.port), "--token-file", daemon.tokenFile], { stdio: "inherit", windowsHide: false });
  const stop = () => { child.kill(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    process.exitCode = code;
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await daemon.close();
  }
}
