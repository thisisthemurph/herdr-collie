// Bitbucket through recorded HTTP (fixtures/bitbucket/), the keychain rules, and the rule that the
// token never leaves the Authorization header and the keychain.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BitbucketCloud } from "../src/bitbucket.ts";
import { keychainBitbucket, type Run } from "../src/credentials.ts";
import type { Http } from "../src/jira.ts";
import { destRef, GitRemote, httpsUrl, KEYCHAIN_HELPER } from "../src/remote.ts";

const FIXTURES = join(import.meta.dir, "../../../fixtures/bitbucket");
const REPO = { workspace: "[WORKSPACE]", slug: "[REPO]" };
const TOKEN = "TOKEN-SENTINEL-do-not-leak";

type Exchange = {
  request: { method: string; url: string; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
};

/** Plays back one recorded step; every request must match it exactly. */
function playback(name: string) {
  const [x] = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")).exchanges as Exchange[];
  const seen: { headers: Record<string, string> }[] = [];
  const http: Http = async (req) => {
    seen.push({ headers: req.headers });
    const body = req.body === undefined ? null : JSON.parse(req.body);
    if (
      !x ||
      x.request.method !== req.method ||
      x.request.url !== req.url ||
      JSON.stringify(x.request.body) !== JSON.stringify(body)
    )
      throw new Error(`no recorded exchange for ${req.method} ${req.url} ${req.body ?? ""}`);
    return { status: x.response.status, headers: x.response.headers, body: JSON.stringify(x.response.body) };
  };
  return { http, seen };
}
const host = (http: Http) => new BitbucketCloud(http, { bitbucket: async () => TOKEN });

describe("Bitbucket Cloud", () => {
  test("checkAccess accepts pullrequest:write alone, and names the missing scope otherwise", async () => {
    const ok = playback("01-repo-scopes");
    await host(ok.http).checkAccess(REPO);
    expect(ok.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const ro = playback("02-repo-read-only");
    await expect(host(ro.http).checkAccess(REPO)).rejects.toThrow(
      /lacks the pullrequest:write scope \(it has: repository\)/,
    );
  });

  test("creates a draft PR and reads it back", async () => {
    const pb = playback("03-create-draft-pr");
    const pr = await host(pb.http).createPr(REPO, {
      title: "PAY-102: Payment API endpoints",
      description: "Jira: https://[SITE].atlassian.net/browse/PAY-102",
      source: "pay-102-payment-api",
      destination: "pay-101-persistence",
      draft: true,
    });
    expect(pr).toMatchObject({
      number: 147,
      state: "OPEN",
      draft: true,
      destination: "pay-101-persistence",
      url: "https://bitbucket.org/[WORKSPACE]/[REPO]/pull-requests/147",
    });
  });

  test("approvals ignore the author's own entry", async () => {
    const pr = await host(playback("04-get-pr-approvals").http).getPr(REPO, 147);
    expect(pr.approvals).toBe(1);
  });

  test("retargets and marks ready in one update", async () => {
    const pr = await host(playback("05-retarget-and-ready").http).updatePr(REPO, 147, {
      destination: "main",
      draft: false,
    });
    expect(pr).toMatchObject({ destination: "main", draft: false });
  });

  test("a failed call says what to fix, and never carries the token", async () => {
    await expect(host(playback("07-unauthorised").http).checkAccess(REPO)).rejects.toThrow(
      /rejected the token \(HTTP 401\)/,
    );
    const f = playback("08-forbidden-create");
    const err = await host(f.http)
      .createPr(REPO, { title: "x", description: "x", source: "a", destination: "main", draft: false })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain("HTTP 403");
    expect((err as Error).message).toContain("pullrequest:write");
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe("the keychain item", () => {
  const dump = (accounts: string[]) =>
    accounts
      .map(
        (a) =>
          `keychain: "x"\nclass: "genp"\nattributes:\n    "acct"<blob>="${a}"\n    "svce"<blob>="collie-bitbucket"\n`,
      )
      .join("");
  const run =
    (accounts: string[], calls: string[][] = []): Run =>
    (args) => {
      calls.push(args);
      if (args[0] === "dump-keychain") return { code: 0, stdout: dump(accounts), stderr: "" };
      return { code: 0, stdout: `${TOKEN}\n`, stderr: "" };
    };

  test("reads the token with -w and nothing else", async () => {
    const calls: string[][] = [];
    expect(await keychainBitbucket(run(["collie"], calls)).bitbucket()).toBe(TOKEN);
    expect(calls.at(-1)).toEqual(["find-generic-password", "-s", "collie-bitbucket", "-a", "collie", "-w"]);
  });

  test("refuses to guess between two items, naming the accounts but not a secret", async () => {
    const err = await keychainBitbucket(run(["a", "b"]))
      .bitbucket()
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/2 keychain items are named collie-bitbucket \(accounts: a, b\)/);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  test("says how to add the item when it is missing", async () => {
    await expect(keychainBitbucket(run([])).bitbucket()).rejects.toThrow(
      /security add-generic-password -s collie-bitbucket/,
    );
  });
});

describe("git over HTTPS", () => {
  test("the URL and the helper carry no token: the helper reads the keychain when git asks", () => {
    expect(httpsUrl(REPO)).toBe("https://bitbucket.org/[WORKSPACE]/[REPO].git");
    expect(httpsUrl(REPO)).not.toContain("@");
    expect(KEYCHAIN_HELPER).toContain("security find-generic-password -s collie-bitbucket -w");
    expect(KEYCHAIN_HELPER).toContain("username=x-token-auth");
    expect(KEYCHAIN_HELPER).not.toContain(TOKEN);
    expect(destRef("main")).toBe("refs/collie/dest/main");
  });

  test("a failed push says which push failed, and its error can't hold a token (git never sees one)", async () => {
    const remote = new GitRemote({ url: () => "/nonexistent/remote.git" });
    const err = await remote.push(process.cwd(), REPO, "main").catch((e: Error) => e);
    expect((err as Error).message).toContain("git push of main failed");
    expect((err as Error).message).not.toContain(TOKEN);
  });
});
