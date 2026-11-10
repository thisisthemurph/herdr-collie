// The Jira Cloud client (docs/plan.md, Phase 3; docs/spike.md, experiment 6).
// Every call goes through https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/... with
// Basic email:token: a scoped token is rejected on the site URL. The cloud id comes from the
// site's unauthenticated /_edge/tenant_info.
import { type JiraIssue, SEARCH_FIELDS } from "@collie/board";
import { adfToText, splitDescription } from "./adf.ts";
import { CommandError } from "./controller.ts";
import type { CredentialSource } from "./credentials.ts";

export type HttpRequest = {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: string;
};
export type HttpResponse = { status: number; headers: Record<string, string>; body: string };
/** The network, as one function, so tests can play back recorded responses. */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: Http = async (req) => {
  const r = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: "follow",
  });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: r.status, headers, body: await r.text() };
};

export const API = (cloudId: string) => `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
const PAGE = 100;
/** Keys per `key in (...)` search, to keep the JQL short. */
const KEYS_PER_SEARCH = 50;

/** How many of the newest comments go into an agent's brief. */
const COMMENTS = 10;

export type TicketBrief = {
  description: string;
  criteria: string;
  comments: { author: string; created: string; text: string }[];
};

/** One transition an issue offers now. */
export type JiraTransition = { id: string; name: string; to: string };

/** What delivery writes back to Jira (docs/protocol.md, "Phase 6 rules"); JiraClient is the real one. */
export type JiraWriteback = {
  transitions(cloudId: string, key: string): Promise<JiraTransition[]>;
  transition(cloudId: string, key: string, transitionId: string): Promise<void>;
  comment(cloudId: string, key: string, text: string): Promise<void>;
};

/** What the launcher needs from Jira; JiraClient is the real one. */
export type BriefSource = { brief(cloudId: string, key: string): Promise<TicketBrief> };

export class JiraClient implements BriefSource, JiraWriteback {
  constructor(
    private readonly http: Http,
    private readonly creds: CredentialSource,
  ) {}

  /** The cloud id of a site such as example.atlassian.net (no auth needed). */
  async cloudId(site: string): Promise<string> {
    const r = await this.send({
      method: "GET",
      url: `https://${site}/_edge/tenant_info`,
      headers: { accept: "application/json" },
    });
    if (r.status !== 200) {
      throw new CommandError(
        "upstream_error",
        `couldn't look up ${site}'s cloud id (HTTP ${r.status}); check the site name`,
      );
    }
    const id = (JSON.parse(r.body) as { cloudId?: string }).cloudId;
    if (!id) throw new CommandError("upstream_error", `${site} returned no cloud id; check the site name`);
    return id;
  }

  /** Every issue a JQL query matches, following nextPageToken (the response has no total). */
  async search(cloudId: string, jql: string): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const body = JSON.stringify({
        jql,
        fields: SEARCH_FIELDS,
        maxResults: PAGE,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      const page = (await this.authed(cloudId, "POST", "/search/jql", body)) as {
        issues?: JiraIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      };
      issues.push(...(page.issues ?? []));
      nextPageToken = page.isLast === false || page.nextPageToken ? page.nextPageToken : undefined;
    } while (nextPageToken);
    return issues;
  }

  /** The issues with these keys (missing ones are left out; see `missing` on the result). */
  async issues(cloudId: string, keys: string[]): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    for (let i = 0; i < keys.length; i += KEYS_PER_SEARCH) {
      const chunk = keys.slice(i, i + KEYS_PER_SEARCH);
      out.push(...(await this.search(cloudId, `key in (${chunk.join(", ")}) ORDER BY key`)));
    }
    return out;
  }

  /** The ticket's description, acceptance criteria and newest comments, as text for an agent. */
  async brief(cloudId: string, key: string): Promise<TicketBrief> {
    const issue = (await this.authed(
      cloudId,
      "GET",
      `/issue/${encodeURIComponent(key)}?fields=description,comment`,
    )) as {
      fields?: {
        description?: unknown;
        comment?: { comments?: { author?: { displayName?: string }; created?: string; body?: unknown }[] };
      };
    };
    const { description, criteria } = splitDescription(issue.fields?.description);
    const comments = (issue.fields?.comment?.comments ?? [])
      .slice(-COMMENTS)
      .reverse()
      .map((c) => ({
        author: c.author?.displayName ?? "someone",
        created: (c.created ?? "").slice(0, 10),
        text: adfToText(c.body),
      }));
    return { description, criteria, comments };
  }

  async transitions(cloudId: string, key: string): Promise<JiraTransition[]> {
    const r = (await this.authed(cloudId, "GET", `/issue/${encodeURIComponent(key)}/transitions`)) as {
      transitions?: { id: string; name: string; to?: { name?: string } }[];
    };
    return (r.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name ?? "" }));
  }

  async transition(cloudId: string, key: string, transitionId: string): Promise<void> {
    await this.authed(
      cloudId,
      "POST",
      `/issue/${encodeURIComponent(key)}/transitions`,
      JSON.stringify({ transition: { id: transitionId } }),
    );
  }

  /** Adds a plain-text comment (as an ADF document of one paragraph per line). */
  async comment(cloudId: string, key: string, text: string): Promise<void> {
    const content = text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    }));
    await this.authed(
      cloudId,
      "POST",
      `/issue/${encodeURIComponent(key)}/comment`,
      JSON.stringify({ body: { type: "doc", version: 1, content } }),
    );
  }

  private async authed(
    cloudId: string,
    method: "GET" | "POST",
    path: string,
    body?: string,
  ): Promise<unknown> {
    const { email, token } = await this.creds.jira();
    const r = await this.send({
      method,
      url: `${API(cloudId)}${path}`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      },
      body,
    });
    if (r.status === 401) {
      const why =
        r.headers["x-failure-category"] === "FAILURE_CLIENT_AUTH"
          ? `Jira rejected the credentials. Check that the account field of the collie-jira keychain item is your Atlassian email (${email}), and that its token is valid and has read:jira-work`
          : "Jira rejected the credentials (HTTP 401)";
      throw new CommandError("upstream_error", why);
    }
    if (r.status === 400) {
      throw new CommandError("invalid_args", `Jira refused the request: ${jiraMessage(r.body)}`);
    }
    if (r.status < 200 || r.status >= 300) {
      throw new CommandError("upstream_error", `Jira returned HTTP ${r.status}: ${jiraMessage(r.body)}`);
    }
    return r.body.trim() ? JSON.parse(r.body) : {};
  }

  private async send(req: HttpRequest): Promise<HttpResponse> {
    try {
      return await this.http(req);
    } catch (e) {
      throw new CommandError("upstream_error", `couldn't reach Jira: ${(e as Error).message}`);
    }
  }
}

function jiraMessage(body: string): string {
  try {
    const j = JSON.parse(body) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
      message?: string;
    };
    const parts = [
      ...(j.errorMessages ?? []),
      ...Object.values(j.errors ?? {}),
      ...(j.message ? [j.message] : []),
    ];
    if (parts.length) return parts.join("; ");
  } catch {}
  return body.slice(0, 300) || "no details";
}
