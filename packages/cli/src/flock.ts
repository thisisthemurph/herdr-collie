// An exclusive advisory lock on an open file, through libc's flock(2). Inbox rule 3: the CLI
// locks the inbox, then writes the whole line in one write().
import { dlopen, FFIType } from "bun:ffi";

const LOCK_EX = 2;
const LOCK_UN = 8;

let flockFn: ((fd: number, op: number) => number) | undefined;

function load(): (fd: number, op: number) => number {
  if (!flockFn) {
    const path = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
    const lib = dlopen(path, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    flockFn = lib.symbols.flock as (fd: number, op: number) => number;
  }
  return flockFn;
}

/** Blocks until this process holds the exclusive lock on `fd`. */
export function lockExclusive(fd: number): void {
  if (load()(fd, LOCK_EX) !== 0) throw Object.assign(new Error("flock(LOCK_EX) failed"), { code: "EFLOCK" });
}

export function unlock(fd: number): void {
  load()(fd, LOCK_UN);
}
