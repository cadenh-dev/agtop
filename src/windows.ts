import koffi from "koffi";
import type { RawOsProcess } from "./types.js";

type Handle = unknown;
export function quoteWindowsArg(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
}
class WindowsApi {
  readonly k = koffi;
  private lib = this.k.load("kernel32.dll");
  private fn(proto: string) { return this.lib.func(proto); }
  private lastError = this.fn("uint32 __stdcall GetLastError()");
  readonly close = this.fn("int __stdcall CloseHandle(void *handle)");
  private createJob = this.fn("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
  private openJob = this.fn("void * __stdcall OpenJobObjectW(uint32 access, int inherit, str16 name)");
  private setJob = this.fn("int __stdcall SetInformationJobObject(void *job, int kind, void *info, uint32 size)");
  private queryJob = this.fn("int __stdcall QueryInformationJobObject(void *job, int kind, void *info, uint32 size, void *returned)");
  readonly terminateJob = this.fn("int __stdcall TerminateJobObject(void *job, uint32 code)");
  private openProcess = this.fn("void * __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)");
  private terminateProcess = this.fn("int __stdcall TerminateProcess(void *process, uint32 code)");
  private getTimes = this.fn("int __stdcall GetProcessTimes(void *process, void *created, void *exited, void *kernel, void *user)");
  private getExitCode = this.fn("int __stdcall GetExitCodeProcess(void *process, _Out_ uint32 *code)");
  private wait = this.fn("uint32 __stdcall WaitForSingleObject(void *handle, uint32 timeout)");
  private resumeThread = this.fn("uint32 __stdcall ResumeThread(void *thread)");
  private initAttributes = this.fn("int __stdcall InitializeProcThreadAttributeList(void *list, uint32 count, uint32 flags, _Inout_ size_t *size)");
  private updateAttribute = this.fn("int __stdcall UpdateProcThreadAttribute(void *list, uint32 flags, uintptr_t key, void *value, size_t size, void *previous, void *returned)");
  private deleteAttributes = this.fn("void __stdcall DeleteProcThreadAttributeList(void *list)");
  private getStdHandle = this.fn("void * __stdcall GetStdHandle(int32 kind)");
  private currentProcess = this.fn("void * __stdcall GetCurrentProcess()");
  private duplicateHandle = this.fn("int __stdcall DuplicateHandle(void *sourceProcess, void *source, void *targetProcess, _Out_ void **target, uint32 access, int inherit, uint32 options)");
  private startup = this.k.struct({
    cb: "uint32", reserved: "void *", desktop: "void *", title: "void *",
    x: "uint32", y: "uint32", width: "uint32", height: "uint32", charsX: "uint32", charsY: "uint32", fill: "uint32", flags: "uint32",
    show: "uint16", reservedSize: "uint16", reservedPtr: "void *", stdin: "void *", stdout: "void *", stderr: "void *", attributes: "void *",
  });
  private processInfo = this.k.struct({ process: "void *", thread: "void *", pid: "uint32", tid: "uint32" });
  private createProcess = this.lib.func("__stdcall", "CreateProcessW", "int", ["str16", "void *", "void *", "void *", "int", "uint32", "void *", "str16", this.k.pointer(this.startup), this.k.out(this.k.pointer(this.processInfo))]);
  check(ok: unknown, operation: string): void { if (!ok) throw new Error(`${operation} failed (Win32 error ${this.lastError()}).`); }
  identity(handle: Handle): string {
    const created = Buffer.alloc(8), other = Buffer.alloc(8);
    this.check(this.getTimes(handle, created, other, other, other), "GetProcessTimes");
    return String((created.readBigUInt64LE() - 116444736000000000n) / 10000n);
  }
  pids(handle: Handle): number[] {
    for (let count = 64; count <= 1048576; count *= 2) {
      const size = this.k.sizeof("uintptr_t");
      const data = Buffer.alloc(8 + count * size);
      if (this.queryJob(handle, 3, data, data.length, null)) {
        const length = data.readUInt32LE(4);
        return Array.from({ length }, (_, i) => size === 8 ? Number(data.readBigUInt64LE(8 + i * size)) : data.readUInt32LE(8 + i * size));
      }
      const error = this.lastError();
      if (error !== 234) throw new Error(`QueryInformationJobObject failed (Win32 error ${error}).`);
    }
    throw new Error("Job PID list exceeds supported size.");
  }
  withJob<T>(name: string, access: number, fn: (handle: Handle) => T): T | undefined {
    const handle = this.openJob(access, 0, name);
    if (!handle) {
      const error = this.lastError();
      if (error === 2) return;
      throw new Error(`OpenJobObject failed (Win32 error ${error}).`);
    }
    try { return fn(handle); } finally { this.close(handle); }
  }
  killProcess(p: RawOsProcess): boolean {
    const handle = this.openProcess(0x1000 | 0x0001 | 0x100000, 0, p.pid);
    this.check(handle, "OpenProcess");
    try {
      if (this.identity(handle) !== p.startTime) throw new Error(`PID ${p.pid} was reused; refusing termination.`);
      this.check(this.terminateProcess(handle, 1), "TerminateProcess");
      return this.wait(handle, 2000) === 0;
    } finally { this.close(handle); }
  }
  launch(name: string, command: string, args: string[], cwd: string, env: Record<string, string>,
    stdio: boolean | { stdin: unknown; stdout: unknown; stderr: unknown }) {
    const supplied = stdio !== null && typeof stdio === "object" ? stdio : undefined;
    const inherit = supplied !== undefined || stdio === true;
    const job = this.createJob(null, name);
    this.check(job, "CreateJobObjectW");
    // Unique names avoid attaching to pre-existing jobs with different limits.
    if (this.lastError() === 183) { this.close(job); throw new Error("Job Object name already exists."); }
    let attributes: unknown, jobList: unknown, handleList: unknown;
    let initialized = false;
    const duplicates: Handle[] = [];
    const info: { process?: Handle; thread?: Handle; pid?: number; tid?: number } = {};
    try {
      const basic = this.k.struct({ processTime: "int64", jobTime: "int64", flags: "uint32", min: "size_t", max: "size_t", active: "uint32", affinity: "uintptr_t", priority: "uint32", scheduling: "uint32" });
      const limits = this.k.struct({ basic, io: this.k.array("uint64", 6), processMemory: "size_t", jobMemory: "size_t", peakProcess: "size_t", peakJob: "size_t" });
      const limitBuffer = Buffer.alloc(this.k.sizeof(limits));
      this.k.encode(limitBuffer, limits, { basic: { flags: 0x2000 } });
      this.check(this.setJob(job, 9, limitBuffer, limitBuffer.length), "SetInformationJobObject");
      if (stdio === true) {
        for (const kind of [-10, -11, -12]) {
          const output: Handle[] = [null];
          this.check(this.duplicateHandle(this.currentProcess(), this.getStdHandle(kind), this.currentProcess(), output, 0, 1, 2), "DuplicateHandle(stdio)");
          duplicates.push(output[0]);
        }
      }
      const size = [0];
      this.initAttributes(null, inherit ? 2 : 1, 0, size);
      attributes = this.k.alloc("uint8", Number(size[0]));
      this.check(this.initAttributes(attributes, inherit ? 2 : 1, 0, size), "InitializeProcThreadAttributeList");
      initialized = true;
      jobList = this.k.alloc("void *", 1);
      this.k.encode(jobList, "void *", job);
      this.check(this.updateAttribute(attributes, 0, 0x2000d, jobList, this.k.sizeof("void *"), null, null), "UpdateProcThreadAttribute(JOB_LIST)");
      if (supplied) {
        handleList = this.k.alloc("void *", 3);
        this.k.encode(handleList, this.k.array("void *", 3), [supplied.stdin, supplied.stdout, supplied.stderr]);
        this.check(this.updateAttribute(attributes, 0, 0x20002, handleList, 3 * this.k.sizeof("void *"), null, null), "UpdateProcThreadAttribute(HANDLE_LIST)");
      } else if (inherit) {
        handleList = this.k.alloc("void *", 3);
        this.k.encode(handleList, this.k.array("void *", 3), duplicates);
        this.check(this.updateAttribute(attributes, 0, 0x20002, handleList, 3 * this.k.sizeof("void *"), null, null), "UpdateProcThreadAttribute(HANDLE_LIST)");
      }
      const startup = { cb: this.k.sizeof(this.startup), flags: inherit ? 0x100 : 1, show: 0,
        stdin: supplied ? supplied.stdin : duplicates[0] ?? null,
        stdout: supplied ? supplied.stdout : duplicates[1] ?? null,
        stderr: supplied ? supplied.stderr : duplicates[2] ?? null,
        attributes };
      const cmdline = Buffer.from([command, ...args].map(quoteWindowsArg).join(" ") + "\0", "utf16le");
      const environment = Buffer.from(Object.entries(env).sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase())).map(([k, v]) => `${k}=${v}`).join("\0") + "\0\0", "utf16le");
      // JOB_LIST assigns containment during creation; suspended startup lets us persist metadata before execution.
      const flags = 0x80000 | 0x400 | 0x4 | (supplied || !inherit ? 0x08000000 : 0);
      this.check(this.createProcess(command, cmdline, null, null, inherit ? 1 : 0, flags, environment, cwd, startup, info), "CreateProcessW");
      const startTime = this.identity(info.process);
      let closed = false;
      return {
        pid: info.pid!, startTime,
        resume: () => { if (this.resumeThread(info.thread) === 0xffffffff) throw new Error("ResumeThread failed."); },
        poll: (): number | undefined => {
          if (this.wait(info.process, 0) !== 0) return;
          const code = [0]; this.check(this.getExitCode(info.process, code), "GetExitCodeProcess"); return code[0];
        },
        close: () => { if (!closed) { closed = true; this.close(info.thread); this.close(info.process); this.close(job); } },
        kill: () => this.check(this.terminateJob(job, 1), "TerminateJobObject"),
      };
    } catch (e) {
      this.terminateJob(job, 1);
      if (info.thread) this.close(info.thread);
      if (info.process) this.close(info.process);
      this.close(job);
      throw e;
    } finally {
      if (initialized) this.deleteAttributes(attributes);
      if (attributes) this.k.free(attributes);
      if (jobList) this.k.free(jobList);
      if (handleList) this.k.free(handleList);
      for (const handle of duplicates) this.close(handle);
    }
  }
}
let api: WindowsApi | undefined;
export function windowsApi() {
  if (process.platform !== "win32") throw new Error("Windows API requested on another platform.");
  return api ??= new WindowsApi();
}
