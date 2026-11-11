// `agtop peers` (contracts 16): this daemon's identity and the trusted-peer list.
// Every mutation goes through PeerRegistry, so peers.json keeps the same validation and
// atomic 0600 writes as the daemon; the private key is never printed.
import * as fs from "node:fs";
import { PeerRegistry } from "./remote/registry.js";
import type { PeerScope } from "./types.js";

const USAGE = "Usage: agtop peers init [--id ID] | list [--json] | add --id ID --url URL --public-key KEY [--scope S] [--prefix P] [--tls-cert FILE] | remove ID";
type FlagKind = "flag" | "value" | "multi";
interface Parsed { flags: Map<string, string[]>; rest: string[] }

function parse(args: string[], spec: Record<string, FlagKind>, usage: string): Parsed {
  const flags = new Map<string, string[]>(), rest: string[] = [];
  const add = (name: string, value: string, multi: boolean): void => {
    if (!multi && flags.has(name)) throw new Error(`Duplicate option: ${name}. ${usage}`);
    flags.set(name, multi ? [...(flags.get(name) ?? []), value] : [value]);
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) { rest.push(...args.slice(index)); break; }
    const kind = spec[arg];
    if (kind === undefined) throw new Error(`Unknown option: ${arg}. ${usage}`);
    if (kind === "flag") { add(arg, "", false); continue; }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${arg}. ${usage}`);
    index += 1;
    add(arg, value, kind === "multi");
  }
  return { flags, rest };
}
const single = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.[0];
const has = (flags: Map<string, string[]>, name: string): boolean => flags.has(name);
const printLine = (text: string): void => { process.stdout.write(`${text}\n`); };
const printJson = (value: unknown): void => { printLine(JSON.stringify(value, null, 2)); };
const oneLine = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

async function init(args: string[]): Promise<void> {
  const { flags, rest } = parse(args, { "--id": "value" }, USAGE);
  if (rest.length) throw new Error(USAGE);
  printJson(new PeerRegistry().ensureIdentity(single(flags, "--id")));
}
async function list(args: string[]): Promise<void> {
  const { flags, rest } = parse(args, { "--json": "flag" }, USAGE);
  if (rest.length) throw new Error(USAGE);
  const peers = new PeerRegistry().list();
  if (has(flags, "--json")) { printJson(peers); return; }
  // Never render tlsCertPem: a terminal row is not a place for a full certificate.
  printLine(peers.length === 0 ? "No peers." : peers.map((peer) => oneLine(
    `${peer.id}  ${peer.url}  ${peer.enabled}  ${peer.scopes.join(",") || "-"}  ${peer.lastSeenAt ?? "-"}`,
  )).join("\n"));
}
async function add(args: string[]): Promise<void> {
  const { flags, rest } = parse(args, {
    "--id": "value", "--url": "value", "--public-key": "value",
    "--scope": "multi", "--prefix": "multi", "--tls-cert": "value",
  }, USAGE);
  if (rest.length) throw new Error(USAGE);
  const id = single(flags, "--id"), url = single(flags, "--url"), publicKey = single(flags, "--public-key");
  if (id === undefined || url === undefined || publicKey === undefined) throw new Error(`--id, --url and --public-key are required. ${USAGE}`);
  const certFile = single(flags, "--tls-cert");
  let tlsCertPem: string | undefined;
  if (certFile !== undefined) {
    try { tlsCertPem = fs.readFileSync(certFile, "utf8"); }
    catch (error) { throw new Error(`Cannot read TLS certificate ${certFile}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const peer = new PeerRegistry().upsert({
    id, url, publicKey, scopes: (flags.get("--scope") ?? []) as PeerScope[], jobPeerPrefixes: flags.get("--prefix") ?? [],
    ...(tlsCertPem === undefined ? {} : { tlsCertPem }),
  });
  printLine(`Added peer ${peer.id}.`);
}
async function remove(args: string[]): Promise<void> {
  const { flags, rest } = parse(args, {}, USAGE);
  if (flags.size || rest.length !== 1) throw new Error(USAGE);
  const id = rest[0]!;
  if (!new PeerRegistry().remove(id)) throw new Error(`no peer named ${id}`);
  printLine(`Removed peer ${id}.`);
}
const COMMANDS: Record<string, (args: string[]) => Promise<void>> = { init, list, add, remove };

/** Runs a `peers` subcommand; usage and runtime errors become `agtop: ...` on stderr and exit 1. */
export async function peersCommand(args: string[]): Promise<void> {
  const command = args[0];
  const run = command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  try {
    if (run === undefined) throw new Error(command === undefined ? USAGE : `Unknown peers command: ${command}. ${USAGE}`);
    await run(args.slice(1));
  } catch (error) {
    process.stderr.write(`agtop: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
