// The mod's link to Collie: reads ~/.collie, sends commands through `collie ctl`, and starts
// the controller when no live one holds the lock (docs/plan.md, Phase 3).
//
// DECISION: the mod runs `collie` and `collie-controller` from the user's PATH (`make install`
// puts them in ~/.local/bin), and uses ~/.collie: a mod can't read the user's environment.

import type { Board, StateFile } from "@collie/schema";
import { readdir } from "fs/promises";
import { exec, hc, home, props, readTextFile } from "herdr";
import type { RunView } from "./model.ts";

// DECISION: a tab opened with the prop `collie_home` reads that folder instead of ~/.collie, so the
// UI can be tried against a hand-made home (`tab.new --mod collie --props '{"collie_home":"…"}'`).
// Commands still go to the controller `collie ctl` finds, so only reading is redirected.
export const collieHome = () =>
  (props() as { collie_home?: string } | undefined)?.collie_home ?? `${home()}/.collie`;

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

/**
 * The board's run to show: the one in progress, else the most recent. Read from run.json and
 * state.json, which the controller writes; the mod never reads events.jsonl.
 */
export async function loadRun(boardId: string): Promise<RunView | null> {
  let ids: string[] = [];
  try {
    ids = await readdir(`${collieHome()}/runs`);
  } catch {
    return null;
  }
  const heads = (
    await Promise.all(
      ids.map(async (id) => {
        const r = await readJson<{
          id: string;
          board_id: string;
          number: number;
          status: RunView["status"];
          snapshot?: { profiles?: Record<string, { name?: string }> };
        }>(`${collieHome()}/runs/${id}/run.json`);
        return r?.board_id === boardId ? r : null;
      }),
    )
  ).filter((r): r is NonNullable<typeof r> => !!r);
  const active = heads.filter((r) => r.status === "running" || r.status === "paused");
  const pick = (active.length ? active : heads).sort((a, b) => b.number - a.number)[0];
  if (!pick) return null;
  const state = await readJson<StateFile>(`${collieHome()}/runs/${pick.id}/state.json`);
  if (!state) return null;
  const profiles = Object.fromEntries(
    Object.entries(pick.snapshot?.profiles ?? {}).flatMap(([id, p]) => (p?.name ? [[id, p.name]] : [])),
  );
  return { id: pick.id, number: pick.number, status: state.status, boardId, state, profiles };
}

/**
 * The requirements analyst's executions, questions and findings for a board (Phase 5): the same
 * file as a run's state.json, at boards/<id>/prep/. It exists only after a first investigation.
 */
export async function loadPrep(boardId: string): Promise<StateFile | null> {
  return readJson<StateFile>(`${collieHome()}/boards/${boardId}/prep/state.json`);
}

/** The workflows a board or ticket can use, from ~/.collie/workflows/*.json, by id. */
export async function loadWorkflows(): Promise<{ id: string; name: string }[]> {
  let files: string[] = [];
  try {
    files = await readdir(`${collieHome()}/workflows`);
  } catch {
    return [];
  }
  const all = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<{ id?: string; name?: string }>(`${collieHome()}/workflows/${f}`)),
  );
  return all
    .flatMap((w) => (w?.id ? [{ id: w.id, name: w.name ?? w.id }] : []))
    .sort((a, b) => a.id.localeCompare(b.id));
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
