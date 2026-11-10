// THROWAWAY SPIKE: Windows capture that keeps the v0.1 launch shape (CreateProcessW + JOB_LIST + CREATE_SUSPENDED).
// Pattern: the daemon owns a libuv named-pipe *server* per stream (overlapped, event-loop driven); the child gets a
// synchronous *client* handle opened with CreateFileW and passed through PROC_THREAD_ATTRIBUTE_HANDLE_LIST.
import koffi from "koffi";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import type { CaptureProvider } from "./fleet-spike.ts";

const k32 = koffi.load("kernel32.dll");
const fn = (proto: string) => k32.func(proto);
const GetLastError = fn("uint32 __stdcall GetLastError()");
const CloseHandle = fn("int __stdcall CloseHandle(void *handle)");
const CreateFileW = fn("void * __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *template)");
const CreateJobObjectW = fn("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
const SetInformationJobObject = fn("int __stdcall SetInformationJobObject(void *job, int kind, void *info, uint32 size)");
const TerminateJobObject = fn("int __stdcall TerminateJobObject(void *job, uint32 code)");
const WaitForSingleObject = fn("uint32 __stdcall WaitForSingleObject(void *handle, uint32 timeout)");
const GetExitCodeProcess = fn("int __stdcall GetExitCodeProcess(void *process, _Out_ uint32 *code)");
const ResumeThread = fn("uint32 __stdcall ResumeThread(void *thread)");
const InitAttrs = fn("int __stdcall InitializeProcThreadAttributeList(void *list, uint32 count, uint32 flags, _Inout_ size_t *size)");
const UpdateAttr = fn("int __stdcall UpdateProcThreadAttribute(void *list, uint32 flags, uintptr_t key, void *value, size_t size, void *previous, void *returned)");
const DeleteAttrs = fn("void __stdcall DeleteProcThreadAttributeList(void *list)");
const STARTUPINFOEX = koffi.struct("SpikeStartupInfoEx", {
  cb: "uint32", reserved: "void *", desktop: "void *", title: "void *",
  x: "uint32", y: "uint32", width: "uint32", height: "uint32", charsX: "uint32", charsY: "uint32", fill: "uint32", flags: "uint32",
  show: "uint16", reservedSize: "uint16", reservedPtr: "void *", stdin: "void *", stdout: "void *", stderr: "void *", attributes: "void *",
});
const PROCESS_INFORMATION = koffi.struct("SpikeProcessInfo", { process: "void *", thread: "void *", pid: "uint32", tid: "uint32" });
const CreateProcessW = k32.func("__stdcall", "CreateProcessW", "int", ["str16", "void *", "void *", "void *", "int", "uint32", "void *", "str16", koffi.pointer(STARTUPINFOEX), koffi.out(koffi.pointer(PROCESS_INFORMATION))]);
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(`${what} failed (Win32 error ${GetLastError()}).`); };
const quote = (v: string) => v && !/[\s"]/.test(v) ? v : '"' + v.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
const INVALID = 0xffffffffffffffffn;

/** Inheritable client handle. SECURITY_ATTRIBUTES is { nLength: 24, lpSecurityDescriptor: null, bInheritHandle: 1 } on x64. */
function openInheritable(name: string, access: number): unknown {
  const sa = Buffer.alloc(24); sa.writeUInt32LE(24, 0); sa.writeInt32LE(1, 16);
  const handle = CreateFileW(name, access, 3, sa, 3 /* OPEN_EXISTING */, 0, null);
  if (!handle || koffi.address(handle) === INVALID) throw new Error(`CreateFileW(${name}) failed (Win32 error ${GetLastError()}).`);
  return handle;
}
/** One pipe instance; the server stops listening as soon as the single expected client is connected. */
function pipeEnd(): Promise<{ name: string; socket: Promise<net.Socket> }> {
  const name = `\\\\.\\pipe\\agtop-spike-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    let connected!: (socket: net.Socket) => void;
    const socket = new Promise<net.Socket>(r => { connected = r; });
    const server = net.createServer(s => { server.close(); connected(s); });
    server.once("error", reject);
    server.listen(name, () => resolve({ name, socket }));
  });
}

export const winJobPipes: CaptureProvider = async (command, args) => {
  const [out, err] = await Promise.all([pipeEnd(), pipeEnd()]);
  const handles = [openInheritable("NUL", 0x80000000), openInheritable(out.name, 0x40000000), openInheritable(err.name, 0x40000000)];
  const job = CreateJobObjectW(null, `Local\\agtop-spike-${randomUUID()}`);
  let attributes: unknown, jobList: unknown, handleList: unknown, initialized = false;
  const info: { process?: unknown; thread?: unknown; pid?: number } = {};
  try {
    check(job, "CreateJobObjectW");
    const limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000 /* KILL_ON_JOB_CLOSE */, 16);
    check(SetInformationJobObject(job, 9, limits, limits.length), "SetInformationJobObject");
    const size = [0];
    InitAttrs(null, 2, 0, size);
    attributes = koffi.alloc("uint8", Number(size[0]));
    check(InitAttrs(attributes, 2, 0, size), "InitializeProcThreadAttributeList"); initialized = true;
    jobList = koffi.alloc("void *", 1); koffi.encode(jobList, "void *", job);
    check(UpdateAttr(attributes, 0, 0x2000d, jobList, koffi.sizeof("void *"), null, null), "UpdateProcThreadAttribute(JOB_LIST)");
    handleList = koffi.alloc("void *", 3); koffi.encode(handleList, koffi.array("void *", 3), handles);
    check(UpdateAttr(attributes, 0, 0x20002, handleList, 3 * koffi.sizeof("void *"), null, null), "UpdateProcThreadAttribute(HANDLE_LIST)");
    const startup = { cb: koffi.sizeof(STARTUPINFOEX), flags: 0x100 /* USESTDHANDLES */, show: 0, stdin: handles[0], stdout: handles[1], stderr: handles[2], attributes };
    const cmdline = Buffer.from([command, ...args].map(quote).join(" ") + "\0", "utf16le");
    // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | CREATE_NO_WINDOW; env null = inherit.
    check(CreateProcessW(command, cmdline, null, null, 1, 0x80000 | 0x400 | 0x4 | 0x08000000, null, process.cwd(), startup, info), "CreateProcessW");
  } catch (e) {
    if (job) { TerminateJobObject(job, 1); CloseHandle(job); }
    throw e;
  } finally {
    if (initialized) DeleteAttrs(attributes);
    for (const p of [attributes, jobList, handleList]) if (p) koffi.free(p);
    // Critical: the daemon must not keep a write end, or the reader never sees EOF.
    for (const handle of handles) CloseHandle(handle);
  }
  const [stdout, stderr] = await Promise.all([out.socket, err.socket]);
  if (ResumeThread(info.thread) === 0xffffffff) throw new Error("ResumeThread failed.");
  const exited = new Promise<number>(resolve => {
    const timer = setInterval(() => {
      if (WaitForSingleObject(info.process, 0) !== 0) return;
      clearInterval(timer);
      const code = [0]; GetExitCodeProcess(info.process, code);
      TerminateJobObject(job, code[0]); // v0.1 semantics: descendants do not outlive the root
      CloseHandle(info.thread); CloseHandle(info.process); CloseHandle(job);
      resolve(code[0]);
    }, 25);
  });
  return { pid: info.pid!, stdout, stderr, exited, kill: () => { TerminateJobObject(job, 137); } };
};
