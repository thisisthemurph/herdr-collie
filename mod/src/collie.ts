// The mod's link to Collie: reads ~/.collie, sends commands through `collie ctl`, and starts
// the controller when no live one holds the lock (docs/plan.md, Phase 3).
//
// DECISION: the mod runs `collie` and `collie-controller` from the user's PATH (`make install`
// puts them in ~/.local/bin), and uses ~/.collie: a mod can't read the user's environment.

import type { Board } from "@collie/schema";
import { readdir } from "fs/promises";
import { exec, hc, home, readTextFile } from "herdr";

export const collieHome = () => `${home()}/.collie`;

export type CtlReply = {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readTextFile(path);
    return text === null ? null : (JSON.parse(text) as T);
  } catch {
    return null;
  }
}

/** Every board under ~/.collie/boards, by name. */
export async function loadBoards(): Promise<Board[]> {
  let ids: string[] = [];
  try {
    ids = await readdir(`${collieHome()}/boards`);
  } catch {
    return [];
  }
  const boards = await Promise.all(
    ids.map((id) => readJson<Board>(`${collieHome()}/boards/${id}/board.json`)),
  );
  return boards.filter((b): b is Board => !!b?.id).sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a live controller holds controller.lock. */
export async function controllerAlive(): Promise<boolean> {
  const lock = await readJson<{ pid?: number }>(`${collieHome()}/controller.lock`);
  if (!lock?.pid) return false;
  try {
    return (await exec("kill", ["-0", String(lock.pid)], { timeout: 5_000 })).code === 0;
  } catch {
    return false;
  }
}

/**
 * Starts the controller in its own hc terminal, labelled collie.role=controller, unless a
 * live one holds the lock (the decisions table: "the mod starts the controller").
 */
export async function ensureController(): Promise<string | null> {
  if (await controllerAlive()) return null;
  const r = await hc([
    "run",
    "--bg",
    "--json",
    "--no-parent",
    "--no-notify",
    "--name",
    "collie-controller",
    "--label",
    "collie.role=controller",
    "--",
    "collie-controller",
  ]);
  if (r.code !== 0) {
    // name_taken: one is starting already; anything else is worth showing.
    if (r.stderr.includes("name_taken")) return null;
    return `couldn't start the controller: ${r.stderr.trim() || r.stdout.trim()}`;
  }
  return null;
}

/** Runs `collie ctl <command> '<args>' --json` and returns the controller's reply. */
export async function ctl(command: string, args: Record<string, unknown>): Promise<CtlReply> {
  try {
    const r = await exec("collie", ["ctl", command, JSON.stringify(args), "--json"], { timeout: 60_000 });
    if (r.stdout.trim()) return JSON.parse(r.stdout) as CtlReply;
    const message = r.stderr.trim().replace(/^collie ctl: /, "") || `collie ctl exited ${r.code}`;
    return { ok: false, error: { code: r.code === 6 ? "not_running" : "error", message } };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "error",
        message: `couldn't run collie: ${(e as Error).message}. Is it on your PATH? (make install)`,
      },
    };
  }
}
