#!/usr/bin/env bun
export * from "./src/index.js";
import { main } from "./src/cli.js";
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  main().catch(e => { console.error(`agtop: ${String(e)}`); process.exitCode = 1; });
}
