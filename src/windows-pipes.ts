// Windows named-pipe capture provider (contracts 6.4, fleet-v0.2.md 7.2). The daemon owns a
// libuv named-pipe server per stream (event-loop driven); the child receives synchronous
// CreateFileW client handles through PROC_THREAD_ATTRIBUTE_HANDLE_LIST.
import koffi from "koffi";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { validateJobId } from "./registry.js";
import type { CaptureProvider, CaptureSession } from "./types.js";

type Handle = unknown;
const GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ_WRITE = 3, OPEN_EXISTING = 3;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const CONNECT_TIMEOUT_MS = 5000;

class WindowsPipeApi {
  readonly k = koffi;
  private lib = this.k.load("kernel32.dll");
  private fn(proto: string) { return this.lib.func(proto); }
  private lastError = this.fn("uint32 __stdcall GetLastError()");
  readonly close = this.fn("int __stdcall CloseHandle(void *handle)");
  private createFile = this.fn("void * __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *template)");
  /** SECURITY_ATTRIBUTES is { nLength, lpSecurityDescriptor, bInheritHandle } on x64. */
  openInheritable(name: string, access: number): Handle {
    const sa = Buffer.alloc(24);
    sa.writeUInt32LE(24, 0);
    sa.writeInt32LE(1, 16);
    const handle = this.createFile(name, access, FILE_SHARE_READ_WRITE, sa, OPEN_EXISTING, 0, null);
    if (!handle || this.k.address(handle) === INVALID_HANDLE_VALUE) {
      throw new Error(`capture-error: CreateFileW failed (Win32 error ${this.lastError()}).`);
    }
    return handle;
  }
}

let api: WindowsPipeApi | undefined;
function pipeApi(): WindowsPipeApi {
  if (process.platform !== "win32") throw new Error("Windows API requested on another platform.");
  return api ??= new WindowsPipeApi();
}

class WindowsPipeCaptureSession implements CaptureSession {
  private released = false;
  private disposed = false;
  constructor(
    private readonly windows: WindowsPipeApi,
    private readonly handles: { stdin: Handle; stdout: Handle; stderr: Handle },
    private readonly sockets: { stdout: net.Socket; stderr: net.Socket },
    private readonly servers: net.Server[],
  ) {}

  posixStdio(): ["ignore", "pipe", "pipe"] {
    throw new Error("posixStdio() is only available from the POSIX capture provider");
  }

  windowsHandles(): { stdin: unknown; stdout: unknown; stderr: unknown } {
    return this.handles;
  }

  attach(): { stdout: net.Socket; stderr: net.Socket } {
    return this.sockets;
  }

  releaseChildEnds(): void {
    if (this.released) return;
    this.released = true;
    this.windows.close(this.handles.stdin);
    this.windows.close(this.handles.stdout);
    this.windows.close(this.handles.stderr);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseChildEnds();
    this.sockets.stdout.destroy();
    this.sockets.stderr.destroy();
    for (const server of this.servers) if (server.listening) server.close();
  }
}

async function listenPipe(name: string): Promise<net.Server> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = () => { server.off("listening", onListening); reject(new Error("capture-error: Windows capture pipe server failed.")); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(name);
    });
    return server;
  } catch (error) {
    if (server.listening) server.close();
    throw error;
  }
}

/** @internal Not part of the capture-provider contract; Unit 2.3 tests inject a failing CreateFileW. */
export interface WindowsPipeOpenOptions {
  /** Pipe-name suffix; production always uses a random UUID. */
  nonce?: string;
  /** Wraps the native client-open call; `open` performs the real CreateFileW. */
  openClient?: (name: string, access: number, open: (name: string, access: number) => Handle) => Handle;
  /** How long to wait for both pipe connections; production uses CONNECT_TIMEOUT_MS. */
  connectTimeoutMs?: number;
}

/** @internal Implementation behind windowsPipeCaptureProvider(); exported only so tests can fail closed. */
export async function openWindowsPipeSession(jobId: string, options: WindowsPipeOpenOptions = {}): Promise<CaptureSession> {
  validateJobId(jobId); // the ID becomes part of the pipe name
  const windows = pipeApi();
  const nonce = options.nonce ?? randomUUID();
  const names = {
    stdin: "NUL",
    stdout: `\\\\.\\pipe\\agtop-${jobId}-stdout-${nonce}`,
    stderr: `\\\\.\\pipe\\agtop-${jobId}-stderr-${nonce}`,
  };
  const servers: net.Server[] = [];
  const sockets: net.Socket[] = [];
  const handles: Handle[] = [];
  try {
    servers.push(await listenPipe(names.stdout));
    servers.push(await listenPipe(names.stderr));
    // The connection comes from the client end opened below, so it fires on a later loop turn
    // whether or not the child exists yet. Closing the server in the handler rejects a second client.
    // A server error or a connection that never arrives fails closed instead of crashing or hanging.
    const connected = servers.map((server) => new Promise<net.Socket>((resolve, reject) => {
      server.once("connection", (socket) => { sockets.push(socket); server.close(); resolve(socket); });
      server.once("error", () => reject(new Error("capture-error: Windows capture pipe server failed.")));
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("capture-error: Windows capture pipe connection timed out.")), options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    });
    const nativeOpen = (name: string, access: number) => windows.openInheritable(name, access);
    const openClient = options.openClient;
    const open = openClient ? (name: string, access: number) => openClient(name, access, nativeOpen) : nativeOpen;
    handles.push(open(names.stdin, GENERIC_READ));
    handles.push(open(names.stdout, GENERIC_WRITE));
    handles.push(open(names.stderr, GENERIC_WRITE));
    let stdout: net.Socket, stderr: net.Socket;
    try { [stdout, stderr] = await Promise.race([Promise.all(connected), timedOut]); } finally { clearTimeout(timer); }
    return new WindowsPipeCaptureSession(windows, {
      stdin: handles[0], stdout: handles[1], stderr: handles[2],
    }, { stdout, stderr }, servers);
  } catch (error) {
    for (const handle of handles) windows.close(handle);
    for (const socket of sockets) socket.destroy();
    for (const server of servers) if (server.listening) server.close();
    if (error instanceof Error && error.message.includes("capture-error")) throw error;
    throw new Error("capture-error: Windows capture pipe setup failed.");
  }
}

export function windowsPipeCaptureProvider(): CaptureProvider {
  return { kind: "pipe", open: (jobId) => openWindowsPipeSession(jobId) };
}
