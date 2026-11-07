import { runWatchdog } from "./watchdog.js";

process.exitCode = await runWatchdog(process.argv.slice(2));
