// Jira through recorded HTTP (fixtures/jira/, recorded from real issues by
// tools/jira-record): board creation, import, refresh, pull-in, overrides, readiness in a run,
// cycles, and credential errors. No network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { edges, layout } from "@collie/board";
import type { Board } from "@collie/schema";
import { Controller } from "../src/controller.ts";
import { keychainAccounts, keychainJira } from "../src/credentials.ts";
import { writeJsonAtomic } from "../src/home.ts";
import type { Http } from "../src/jira.ts";
import { JiraClient } from "../src/jira.ts";
import { command, FIXTURES, fakeClock, ok, readEvents, type Scratch, scratchHome } from "./helpers.ts";

type Exchange = {
  request: { method: string; url: string; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
};
const step = (name: string): Exchange[] =>
  JSON.parse(readFileSync(join(FIXTURES, `jira/${name}.json`), "utf8")).exchanges;

/** Plays back recorded exchanges: each request must match one, in any order, once. */
class Playback {
  queue: Exchange[] = [];
  seen: string[] = [];
  load(...names: string[]) {
    for (const n of names) this.queue.push(...step(n));
  }
  http: Http = async (req) => {
    const body = req.body === undefined ? null : JSON.parse(req.body);
    this.seen.push(req.headers.authorization ? "auth" : "no-auth");
    const i = this.queue.findIndex(
      (x) =>
        x.request.method === req.method &&
        x.request.url === req.url &&
        JSON.stringify(x.request.body) === JSON.stringify(body),
    );
    if (i === -1) throw new Error(`no recorded exchange for ${req.method} ${req.url} ${req.body ?? ""}`);
    const [x] = this.queue.splice(i, 1) as [Exchange];
    return { status: x.response.status, headers: x.response.headers, body: JSON.stringify(x.response.body) };
  };
}

const CREDS = { jira: async () => ({ email: "agent@example.com", token: "not-a-real-token" }) };
let s: Scratch;
let c: Controller;
let pb: Playback;

beforeEach(() => {
  s = scratchHome();
  pb = new Playback();
  c = new Controller(s.home, fakeClock(), () => {}, new JiraClient(pb.http, CREDS));
  c.recover();
});
afterEach(() => s.cleanup());

const board = (id: string): Board => JSON.parse(readFileSync(s.home.board(id), "utf8"));

async function createAndImport(): Promise<string> {
  pb.load("01-board-create", "02-import-five");
  const boardId = ok(
    await command(c, "board.create", {
      name: "Collie test board",
      jira: { site: "[SITE].atlassian.net", project: "TST" },
      repo: { workspace: "[WORKSPACE]", slug: "[REPO]", default_branch: "main", local_path: "~/code/[REPO]" },
    }),
  ).board_id as string;
  const r = ok(
    await command(c, "board.import", {
      board_id: boardId,
      keys: ["TST-1", "TST-2", "TST-3", "TST-4", "TST-5"],
    }),
  );
  expect(r).toEqual({ added: ["TST-1", "TST-2", "TST-3", "TST-4", "TST-5"], external: ["TST-6"] });
  return boardId;
}

test("board.create looks up the cloud id from the site, once, without auth", async () => {
  const id = await createAndImport();
  expect(board(id).jira).toEqual({ site: "[SITE].atlassian.net", cloud_id: "[CLOUD-ID]", project: "TST" });
  expect(pb.seen).toEqual(["no-auth", "auth"]);
});

test("importing five tickets with known links produces the expected graph", async () => {
  const b = board(await createAndImport());
  // Linked in Jira as: 1 blocks 2, 2 blocks 4, 3 blocks 4, X (TST-6) blocks 3, 4 blocks 5;
  // plus a Relates link 1 - 5, which must not order anything.
  expect(edges(b).map((e) => `${e.from}>${e.to}${e.external ? " (external)" : ""}`)).toEqual([
    "TST-1>TST-2",
    "TST-6>TST-3 (external)",
    "TST-2>TST-4",
    "TST-3>TST-4",
    "TST-4>TST-5",
  ]);
  expect(
    Object.entries(b.tickets)
      .filter(([, t]) => !t.on_board)
      .map(([k]) => k),
  ).toEqual(["TST-6"]);
  expect(b.tickets["TST-1"]).toMatchObject({
    summary: "[Collie test] 1 · Persistence layer",
    jira_status: "To Do",
    status_category: "new",
    preparation: "unreviewed",
  });
  const l = layout(b);
  expect(l.nodes.map((n) => `${n.key}@${n.layer}`).sort()).toEqual([
    "TST-1@0",
    "TST-2@1",
    "TST-3@1",
    "TST-4@2",
    "TST-5@3",
    "TST-6@0",
  ]);
});

describe("readiness", () => {
  async function runWithAllPrepared(boardId: string) {
    for (const k of ["TST-1", "TST-2", "TST-3", "TST-4", "TST-5"]) {
      ok(await command(c, "ticket.set_preparation", { board_id: boardId, ticket: k, preparation: "ready" }));
    }
    const runId = ok(await command(c, "run.start", { board_id: boardId })).run_id as string;
    return {
      runId,
      states: () =>
        Object.fromEntries(
          Object.entries(c.runs.get(runId)?.state.tickets ?? {}).map(([k, t]) => [k, t.state]),
        ),
    };
  }

  test("changes when a blocker's Jira status changes and you refresh", async () => {
    const boardId = await createAndImport();
    const { runId, states } = await runWithAllPrepared(boardId);
    expect(states()).toEqual({
      "TST-1": "ready",
      "TST-2": "blocked",
      "TST-3": "blocked",
      "TST-4": "blocked",
      "TST-5": "blocked",
    });

    pb.load("03-refresh-blocker-todo");
    expect(ok(await command(c, "board.refresh", { board_id: boardId }))).toEqual({
      changed: [],
      missing: [],
      readiness_changed: [],
    });
    expect(states()["TST-3"]).toBe("blocked");

    // TST-6 (X) moved to Done in Jira between the two recordings.
    pb.load("04-refresh-blocker-done");
    expect(ok(await command(c, "board.refresh", { board_id: boardId }))).toEqual({
      changed: ["TST-6"],
      missing: [],
      readiness_changed: ["TST-3"],
    });
    expect(states()["TST-3"]).toBe("ready");
    expect(
      readEvents(s.home, runId).find(
        (e) => e.type === "ticket.state_changed" && e.ticket === "TST-3" && e.payload.to === "ready",
      )?.payload,
    ).toEqual({
      from: "blocked",
      to: "ready",
      reason: "every blocker is satisfied",
    });
    expect(pb.queue).toEqual([]);
  });

  test("an override readies a ticket at once; restoring it blocks it again", async () => {
    const boardId = await createAndImport();
    const { states } = await runWithAllPrepared(boardId);
    ok(await command(c, "dep.override", { board_id: boardId, blocker: "TST-6", blocked: "TST-3" }));
    expect(states()["TST-3"]).toBe("ready");
    ok(await command(c, "dep.restore", { board_id: boardId, blocker: "TST-6", blocked: "TST-3" }));
    expect(states()["TST-3"]).toBe("blocked");
  });
});

test("a blocker outside the board can be pulled in, with its own status fetched", async () => {
  const boardId = await createAndImport();
  pb.load("03-refresh-blocker-todo", "04-refresh-blocker-done");
  await command(c, "board.refresh", { board_id: boardId });
  await command(c, "board.refresh", { board_id: boardId });
  pb.load("05-pull-in");
  expect(ok(await command(c, "ticket.pull_in", { board_id: boardId, ticket: "TST-6" }))).toEqual({
    added: ["TST-6"],
    external: [],
  });
  expect(board(boardId).tickets["TST-6"]).toMatchObject({
    on_board: true,
    jira_status: "Done",
    resolution: "Done",
    preparation: "unreviewed",
  });
  expect(edges(board(boardId)).every((e) => !e.external)).toBe(true);
  expect(await command(c, "ticket.pull_in", { board_id: boardId, ticket: "TST-6" })).toMatchObject({
    ok: false,
    error: { code: "invalid_state" },
  });
});

test("a cycle is reported and blocks Start run", async () => {
  const cycle = JSON.parse(readFileSync(join(FIXTURES, "boards/cycle.json"), "utf8")) as Board;
  writeJsonAtomic(s.home.board(cycle.id), cycle);
  const r = await command(c, "run.start", { board_id: cycle.id });
  expect(r).toMatchObject({
    ok: false,
    error: {
      code: "cycle_detected",
      message:
        "the board's dependencies have a cycle: PAY-1 -> PAY-2 -> PAY-3 -> PAY-1. Remove a link in Jira and refresh, or override one link.",
    },
  });
  expect(c.runs.size).toBe(0);
  // Overriding one link breaks the cycle, and the run starts.
  ok(await command(c, "dep.override", { board_id: cycle.id, blocker: "PAY-3", blocked: "PAY-1" }));
  expect(ok(await command(c, "run.start", { board_id: cycle.id })).run_id).toBeString();
});

describe("Jira errors", () => {
  const client = (status: number, headers: Record<string, string> = {}, body = "{}") =>
    new JiraClient(async () => ({ status, headers, body }), CREDS);

  test("a 401 with FAILURE_CLIENT_AUTH says to check the email and the token", async () => {
    const e = await client(401, { "x-failure-category": "FAILURE_CLIENT_AUTH" })
      .search("[CLOUD-ID]", "x")
      .catch((x) => x);
    expect(e.code).toBe("upstream_error");
    expect(e.message).toContain(
      "Check that the account field of the collie-jira keychain item is your Atlassian email (agent@example.com)",
    );
  });

  test("a 400 is the caller's mistake, with Jira's own message", async () => {
    const e = await client(400, {}, JSON.stringify({ errorMessages: ["Error in the JQL Query: bad"] }))
      .search("[CLOUD-ID]", "x")
      .catch((x) => x);
    expect([e.code, e.message]).toEqual([
      "invalid_args",
      "Jira refused the request: Error in the JQL Query: bad",
    ]);
  });

  test("an unreachable network is an upstream error", async () => {
    const e = await new JiraClient(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }, CREDS)
      .cloudId("[SITE].atlassian.net")
      .catch((x) => x);
    expect([e.code, e.message]).toEqual(["upstream_error", "couldn't reach Jira: getaddrinfo ENOTFOUND"]);
  });

  test("search follows nextPageToken until isLast", async () => {
    const pages = [
      { issues: [{ key: "A-1", fields: {} }], nextPageToken: "p2", isLast: false },
      { issues: [{ key: "A-2", fields: {} }], isLast: true },
    ];
    const bodies: unknown[] = [];
    const j = new JiraClient(async (req) => {
      bodies.push(JSON.parse(req.body as string));
      return { status: 200, headers: {}, body: JSON.stringify(pages.shift()) };
    }, CREDS);
    expect((await j.search("[CLOUD-ID]", "project = A")).map((i) => i.key)).toEqual(["A-1", "A-2"]);
    expect((bodies[1] as { nextPageToken: string }).nextPageToken).toBe("p2");
  });
});

describe("keychain", () => {
  const dump = (items: [string, string][]) =>
    items
      .map(
        ([svce, acct]) =>
          `keychain: "/Users/x/Library/Keychains/login.keychain-db"\nversion: 512\nclass: "genp"\nattributes:\n    "acct"<blob>="${acct}"\n    "svce"<blob>="${svce}"\n`,
      )
      .join("");
  const fake =
    (items: [string, string][], token = "tok") =>
    (args: string[]) =>
      args[0] === "dump-keychain"
        ? { code: 0, stdout: dump(items), stderr: "" }
        : { code: 0, stdout: `${token}\n`, stderr: "" };

  test("reads the one item: the account is the email, the password the token", async () => {
    expect(
      await keychainJira(
        fake([
          ["collie-jira", "me@example.com"],
          ["other", "x"],
        ]),
      ).jira(),
    ).toEqual({ email: "me@example.com", token: "tok" });
  });

  test("refuses when more than one item has the service name, naming the accounts", async () => {
    const run = fake([
      ["collie-jira", "old"],
      ["collie-jira", "me@example.com"],
    ]);
    expect(keychainAccounts("collie-jira", run)).toEqual(["old", "me@example.com"]);
    const e = await keychainJira(run)
      .jira()
      .catch((x) => x);
    expect(e.message).toContain("2 keychain items are named collie-jira (accounts: old, me@example.com)");
  });

  test("a missing item says how to add one", async () => {
    const e = await keychainJira(fake([]))
      .jira()
      .catch((x) => x);
    expect(e.message).toContain("security add-generic-password -s collie-jira -a <your Atlassian email> -w");
  });
});
