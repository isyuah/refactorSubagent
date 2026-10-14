/** Internal Windows adapter. One Job owns this host and all target descendants. */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawn } from "node:child_process";
import type { OwnedProcessOptions } from "./owned-process.js";

const kernel = dlopen("kernel32.dll", {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  SetInformationJobObject: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
});

let received = false;
let finishing = false;
process.on("disconnect", () => process.exit(1));
process.on("message", (options: OwnedProcessOptions) => {
  if (received) return;
  received = true;
  try {
    enterJob();
    const env = { ...options.env };
    delete env.NODE_CHANNEL_FD;
    delete env.NODE_CHANNEL_SERIALIZATION_MODE;
    const child = spawn(options.program, [...options.args], {
      cwd: options.cwd, env, stdio: "inherit", shell: options.shell === true, windowsHide: true,
    });
    child.once("error", (error) => finish({ code: null, signal: null, error: error.message }, 1));
    // `close` can be held by a grandchild's inherited stdout/stderr forever.
    // Exiting this host on `exit` closes the Job and terminates those descendants.
    child.once("exit", (code, signal) => finish({ code, signal, error: null }, code ?? 1));
  } catch (error) {
    finish({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) }, 1);
  }
});

function enterJob(): void {
  const job = kernel.symbols.CreateJobObjectW(null, null);
  if (!job) throw winError("CreateJobObjectW");
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION layout on Windows x64/arm64:
  // size 144, BasicLimitInformation.LimitFlags offset 16.
  if (process.arch !== "x64" && process.arch !== "arm64") throw new Error(`unsupported Windows architecture: ${process.arch}`);
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(16, 0x2000, true); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (!kernel.symbols.SetInformationJobObject(job, 9, ptr(limits), limits.length)) {
    throw winError("SetInformationJobObject");
  }
  const self = kernel.symbols.OpenProcess(0x101, 0, process.pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
  if (!self) throw winError("OpenProcess");
  const assigned = kernel.symbols.AssignProcessToJobObject(job, self);
  const error = assigned ? null : winError("AssignProcessToJobObject");
  kernel.symbols.CloseHandle(self);
  if (error !== null) throw error;
  // Deliberately retain the Job handle until host exit. Children inherit Job
  // membership, not this handle, so the host owns its entire lifetime.
}

function winError(operation: string): Error {
  return new Error(`${operation} failed (Windows error ${kernel.symbols.GetLastError()})`);
}

function finish(message: unknown, code: number): void {
  if (finishing) return;
  finishing = true;
  if (!process.connected || process.send === undefined) process.exit(code);
  process.send(message, () => process.exit(code));
}
