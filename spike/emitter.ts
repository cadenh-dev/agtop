// THROWAWAY SPIKE child. Usage: bun spike/emitter.ts <totalBytes> [die|slow|forever]
// Uses blocking writes on fds 1/2, so it deadlocks if the parent ever stops draining.
import * as fs from "node:fs";

const PAD = "x".repeat(40);
/** Deterministic line i: every 10th goes to stderr; secrets are sprinkled in; multi-byte UTF-8 on every line. */
export function lineFor(i: number): { stream: "stdout" | "stderr"; raw: string; redacted: string } {
  const token = (i * 2654435761 >>> 0).toString(36).padStart(8, "0").repeat(6);
  const base = `${i}|héllo ✓ 日本語 🚀|${PAD}`;
  let raw = base, redacted = base;
  if (i % 97 === 0) { raw += ` key=sk-${token}`; redacted += " key=[REDACTED:openai-key]"; }
  if (i % 131 === 0) { raw += ` ghp_${token}`; redacted += " [REDACTED:github-token]"; }
  if (i % 211 === 0) { raw += ` DEEPSEEK_API_KEY=${token}`; redacted += " DEEPSEEK_API_KEY=[REDACTED:env-secret]"; }
  return { stream: i % 10 === 9 ? "stderr" : "stdout", raw, redacted };
}

function writeAll(fd: number, buf: Buffer) {
  for (let off = 0; off < buf.length;) {
    try { off += fs.writeSync(fd, buf, off); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e; }
  }
}

if (import.meta.main) {
  const total = Number(process.argv[2]), mode = process.argv[3];
  if (mode === "slow") {
    for (let i = 0; ; i++) { writeAll(1, Buffer.from(`${i}|tick\n`)); await new Promise(r => setTimeout(r, 5)); }
  }
  let sent = 0, out: string[] = [], err: string[] = [];
  const flush = () => { writeAll(1, Buffer.from(out.join(""))); writeAll(2, Buffer.from(err.join(""))); out = []; err = []; };
  for (let i = 0; sent < total || mode === "forever"; i++) {
    const line = lineFor(i), text = line.raw + "\n";
    (line.stream === "stdout" ? out : err).push(text); sent += Buffer.byteLength(text);
    if (i % 500 === 499) flush();
  }
  flush();
  if (mode === "die") {
    // Exit mid-write: an unterminated line that ends inside a 4-byte code point.
    writeAll(1, Buffer.concat([Buffer.from("partial line without newline "), Buffer.from("🚀").subarray(0, 2)]));
    process.exit(7);
  }
}
