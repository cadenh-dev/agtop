import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const cargoLocal = path.join(os.homedir(), ".cargo", "bin", windows ? "cargo.exe" : "cargo");
const cargo = fs.existsSync(cargoLocal) ? cargoLocal : "cargo";
const environment = { ...process.env };
// Optional, project-local toolchain for machines without a system VS installation.
const portable = path.join(root, ".tools", "msvc");
if (windows && fs.existsSync(path.join(portable, "VC", "Tools", "MSVC"))) {
  const version = fs.readdirSync(path.join(portable, "VC", "Tools", "MSVC")).sort().at(-1)!;
  const sdk = fs.readdirSync(path.join(portable, "Windows Kits", "10", "Lib")).sort().at(-1)!;
  const vc = path.join(portable, "VC", "Tools", "MSVC", version);
  const kits = path.join(portable, "Windows Kits", "10");
  const pathKey = Object.keys(environment).find(k => k.toUpperCase() === "PATH") || "PATH";
  environment[pathKey] = [path.join(vc, "bin", "Hostx64", "x64"), path.join(kits, "bin", sdk, "x64"), environment[pathKey]].join(path.delimiter);
  environment.INCLUDE = [path.join(vc, "include"), ...["ucrt", "shared", "um", "winrt", "cppwinrt"].map(p => path.join(kits, "Include", sdk, p))].join(";");
  environment.LIB = [path.join(vc, "lib", "x64"), ...["ucrt", "um"].map(p => path.join(kits, "Lib", sdk, p, "x64"))].join(";");
  environment.VCINSTALLDIR = path.join(portable, "VC") + path.sep;
  environment.VCToolsInstallDir = vc + path.sep;
  environment.WindowsSdkDir = kits + path.sep;
  environment.WindowsSDKVersion = sdk + path.sep;
}
const mode = process.argv[2] || "build";
if (!["build", "check", "test", "clippy", "fmt"].includes(mode)) throw new Error("Expected build, check, test, clippy, or fmt.");
const extra = process.argv.slice(3);
if (process.platform === "darwin" && ["build", "check", "test", "clippy"].includes(mode)) {
  if (environment.AGTOP_GPUI_RUNTIME_SHADERS === "1") {
    extra.push("--features", "runtime-shaders");
  } else {
    const metal = spawn("xcrun", ["-sdk", "macosx", "metal", "-v"], { cwd: root, env: environment, stdio: "ignore", windowsHide: true });
    const metalCode = await new Promise<number>(resolve => { metal.once("error", () => resolve(1)); metal.once("exit", code => resolve(code ?? 1)); });
    if (metalCode) {
      console.error("Metal compiler unavailable. Install Xcode and run `xcodebuild -downloadComponent MetalToolchain`, or set AGTOP_GPUI_RUNTIME_SHADERS=1.");
      process.exit(1);
    }
  }
}
// Bun strips a script's first '--'; restore the rustc separator for Clippy lint flags.
if (mode === "clippy" && !extra.includes("--")) {
  const lint = extra.findIndex(v => /^-[ADWF]$|^--(deny|warn|allow|forbid)$/.test(v));
  if (lint >= 0) extra.splice(lint, 0, "--");
}
const args = [mode, "--manifest-path", path.join(root, "desktop", "Cargo.toml"), ...extra];
const child = spawn(cargo, args, { cwd: root, env: environment, stdio: "inherit", windowsHide: true });
const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
if (code) process.exit(code);
if (mode === "build") {
  const filename = windows ? "agtop-desktop.exe" : "agtop-desktop";
  const profile = args.includes("--release") ? "release" : "debug";
  const output = path.join(root, "dist", filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(path.join(root, "desktop", "target", profile, filename), output);
  console.log(`Desktop executable: ${output}`);
}
