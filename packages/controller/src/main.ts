// collie-controller: the long-lived controller process.
//
//   collie-controller [--home <dir>]     (default: $COLLIE_HOME, else ~/.collie)
//
// Exits 1 when another live controller holds controller.lock. SIGTERM or SIGINT flush
// state.json and release the lock; kill -9 is survived by recovery on the next start.
import { appendFileSync, mkdirSync } from "node:fs";
import { newUlid } from "@collie/schema";
import { Controller } from "./controller.ts";
import { defaultHome, Home } from "./home.ts";
import { acquireLock, LockHeldError, releaseLock } from "./lock.ts";

export const TICK_MS = 50;

function parseHome(argv: string[]): string {
  const i = argv.indexOf("--home");
  if (i !== -1) {
    const v = argv[i + 1];
    if (!v) {
      console.error("collie-controller: --home needs a folder");
      process.exit(2);
    }
    return v;
  }
  return defaultHome();
}

export function start(root: string): { controller: Controller; stop: () => void } {
  const home = new Home(root);
  mkdirSync(root, { recursive: true });
  const log = (m: string) => {
    try {
      appendFileSync(home.log, `${new Date().toISOString()} [${process.pid}] ${m}\n`);
    } catch {}
  };
  const { staleReplaced } = acquireLock(home.lock);
  if (staleReplaced) log(`replaced a stale lock left by pid ${staleReplaced.pid}`);
  const controller = new Controller(home, { now: () => Date.now(), id: () => newUlid() }, log);
  controller.recover();
  log(`controller started (home ${root})`);
  let stopped = false;
  const timer = setInterval(() => {
    try {
      controller.tick();
    } catch (e) {
      log(`tick failed: ${(e as Error).stack ?? e}`);
    }
  }, TICK_MS);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    controller.flushAll();
    releaseLock(home.lock);
    log("controller stopped");
  };
  return { controller, stop };
}

if (import.meta.main) {
  const root = parseHome(process.argv.slice(2));
  try {
    const { stop } = start(root);
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.on(sig, () => {
        stop();
        process.exit(0);
      });
    }
  } catch (e) {
    if (e instanceof LockHeldError) {
      console.error(`collie-controller: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
