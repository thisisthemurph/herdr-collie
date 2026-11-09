// controller.lock: one live controller. Created with O_EXCL, so two controllers starting at
// the same moment can't both win. A lock whose pid is dead is stale and is replaced.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { type ControllerLock, validateLock } from "@collie/schema";

export type LockHolder = ControllerLock;

/** Whether a process with this pid exists (EPERM means it exists but isn't ours). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(path: string): LockHolder | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const r = validateLock(JSON.parse(raw));
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

/** The live holder of the lock, or null when there is none (missing, unreadable or dead pid). */
export function liveHolder(path: string): LockHolder | null {
  const h = readLock(path);
  return h && pidAlive(h.pid) ? h : null;
}

export class LockHeldError extends Error {
  constructor(readonly holder: LockHolder) {
    super(
      `another controller is running (pid ${holder.pid}, started ${holder.started_at}); only one controller may hold controller.lock`,
    );
  }
}

/**
 * Takes the lock for this process. Throws LockHeldError while a live controller holds it;
 * replaces a stale lock (dead pid, or a file that isn't a valid lock).
 */
export function acquireLock(path: string, now: Date = new Date()): { staleReplaced: LockHolder | null } {
  let staleReplaced: LockHolder | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        const lock: ControllerLock = { v: 1, pid: process.pid, started_at: now.toISOString() };
        writeSync(fd, `${JSON.stringify(lock)}\n`);
      } finally {
        closeSync(fd);
      }
      return { staleReplaced };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = readLock(path);
    if (holder && pidAlive(holder.pid) && holder.pid !== process.pid) throw new LockHeldError(holder);
    // Stale: dead pid, or garbage. Remove it and try again; O_EXCL settles any race.
    staleReplaced = holder;
    try {
      unlinkSync(path);
    } catch {}
  }
  throw new Error(`could not take ${path} after removing a stale lock three times`);
}

/** Removes the lock if this process holds it. */
export function releaseLock(path: string): void {
  const h = readLock(path);
  if (h?.pid === process.pid) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
