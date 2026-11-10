// The code host (docs/plan.md, Phase 6): the PR operations the controller needs, behind one
// interface so GitHub can be added later, and Bitbucket Cloud's REST API as its one implementation.
// Calls go to api.bitbucket.org/2.0 with the access token as a Bearer token, read from the
// keychain for each request (CLAUDE.md, "Secrets"). Nothing here touches git; see remote.ts.
import { PR_STATES } from "@collie/schema";
import { CommandError } from "./controller.ts";
import type { TokenSource } from "./credentials.ts";
import type { Http, HttpRequest, HttpResponse } from "./jira.ts";

export type Repo = { workspace: string; slug: string };

export type PrInfo = {
  number: number;
  url: string;
  state: (typeof PR_STATES)[number];
  draft: boolean;
  source: string;
  destination: string;
  /** Approvals from anyone but the PR's author (Bitbucket doesn't count the author's own). */
  approvals: number;
};

export type NewPr = {
  title: string;
  description: string;
  source: string;
  destination: string;
  draft: boolean;
};

export interface CodeHost {
  /** Checks the token can read the repository and open PRs; throws naming what is missing. */
  checkAccess(repo: Repo): Promise<void>;
  /** The open PR from `source`, if there is one (so a retry never opens a second). */
  findOpenPr(repo: Repo, source: string): Promise<PrInfo | null>;
  createPr(repo: Repo, pr: NewPr): Promise<PrInfo>;
  getPr(repo: Repo, number: number): Promise<PrInfo>;
  /** Changes a PR's destination branch and/or its draft flag. */
  updatePr(repo: Repo, number: number, change: { destination?: string; draft?: boolean }): Promise<PrInfo>;
}

export const BITBUCKET_API = "https://api.bitbucket.org/2.0";

/** Scopes that let Collie open PRs; in Bitbucket `pullrequest:write` includes `repository:write`. */
const WRITE_SCOPES = ["pullrequest:write", "repository:write"];

type Raw = {
  id?: number;
  state?: string;
  draft?: boolean;
  links?: { html?: { href?: string } };
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
  author?: { uuid?: string };
  participants?: { approved?: boolean; user?: { uuid?: string } }[];
};

export class BitbucketCloud implements CodeHost {
  constructor(
    private readonly http: Http,
    private readonly creds: TokenSource,
  ) {}

  async checkAccess(repo: Repo): Promise<void> {
    const r = await this.call("GET", this.repoUrl(repo), undefined, [200]);
    const header = r.headers["x-oauth-scopes"];
    // DECISION: a token that reports no scopes isn't refused here; the first write says what is
    // missing. Only a token that reports scopes is held to them.
    if (header === undefined) return;
    const scopes = header
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!scopes.some((s) => WRITE_SCOPES.includes(s))) {
      throw new CommandError(
        "upstream_error",
        `the collie-bitbucket token lacks the pullrequest:write scope (it has: ${scopes.join(", ") || "none"}). Create a repository access token with pullrequest:write and save it in that keychain item`,
      );
    }
  }

  async findOpenPr(repo: Repo, source: string): Promise<PrInfo | null> {
    const q = encodeURIComponent(`source.branch.name="${source}" AND state="OPEN"`);
    const r = await this.call("GET", `${this.repoUrl(repo)}/pullrequests?q=${q}`, undefined, [200]);
    const first = (JSON.parse(r.body) as { values?: Raw[] }).values?.[0];
    // The list view has no participants, so read the PR itself for its approvals.
    return first?.id ? this.getPr(repo, first.id) : null;
  }

  async createPr(repo: Repo, pr: NewPr): Promise<PrInfo> {
    const r = await this.call(
      "POST",
      `${this.repoUrl(repo)}/pullrequests`,
      {
        title: pr.title,
        description: pr.description,
        source: { branch: { name: pr.source } },
        destination: { branch: { name: pr.destination } },
        draft: pr.draft,
        close_source_branch: false,
      },
      [200, 201],
    );
    return this.read(JSON.parse(r.body) as Raw);
  }

  async getPr(repo: Repo, number: number): Promise<PrInfo> {
    const r = await this.call("GET", `${this.repoUrl(repo)}/pullrequests/${number}`, undefined, [200]);
    return this.read(JSON.parse(r.body) as Raw);
  }

  async updatePr(
    repo: Repo,
    number: number,
    change: { destination?: string; draft?: boolean },
  ): Promise<PrInfo> {
    const body: Record<string, unknown> = {};
    if (change.destination) body.destination = { branch: { name: change.destination } };
    if (change.draft !== undefined) body.draft = change.draft;
    const r = await this.call("PUT", `${this.repoUrl(repo)}/pullrequests/${number}`, body, [200]);
    return this.read(JSON.parse(r.body) as Raw);
  }

  private repoUrl(repo: Repo): string {
    return `${BITBUCKET_API}/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.slug)}`;
  }

  private read(p: Raw): PrInfo {
    const state = PR_STATES.find((s) => s === p.state);
    if (!p.id || !state || !p.source?.branch?.name || !p.destination?.branch?.name) {
      throw new CommandError(
        "upstream_error",
        "Bitbucket returned a pull request in a shape Collie doesn't know",
      );
    }
    const author = p.author?.uuid;
    return {
      number: p.id,
      url: p.links?.html?.href ?? "",
      state,
      draft: p.draft === true,
      source: p.source.branch.name,
      destination: p.destination.branch.name,
      approvals: (p.participants ?? []).filter((x) => x.approved && x.user?.uuid !== author).length,
    };
  }

  private async call(
    method: HttpRequest["method"],
    url: string,
    body: unknown,
    allow: number[],
  ): Promise<HttpResponse> {
    const token = await this.creds.bitbucket();
    let r: HttpResponse;
    try {
      r = await this.http({
        method,
        url,
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${token}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new CommandError("upstream_error", `couldn't reach Bitbucket: ${(e as Error).message}`);
    }
    if (allow.includes(r.status)) return r;
    if (r.status === 401)
      throw new CommandError(
        "upstream_error",
        "Bitbucket rejected the token (HTTP 401); check the collie-bitbucket keychain item",
      );
    if (r.status === 403)
      throw new CommandError(
        "upstream_error",
        `Bitbucket refused the request (HTTP 403): ${bitbucketMessage(r.body)}. The token needs pullrequest:write`,
      );
    if (r.status === 404)
      throw new CommandError(
        "upstream_error",
        "Bitbucket says that doesn't exist (HTTP 404): check the board's repository workspace and slug",
      );
    throw new CommandError(
      "upstream_error",
      `Bitbucket returned HTTP ${r.status}: ${bitbucketMessage(r.body)}`,
    );
  }
}

function bitbucketMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } };
    if (j.error?.message) return j.error.message;
  } catch {}
  return body.slice(0, 300) || "no details";
}
