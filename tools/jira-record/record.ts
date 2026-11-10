// Records real Jira traffic for Collie's tests: drives the real controller and Jira client
// against a site, saving every HTTP exchange, scrubbed, to fixtures/jira/<step>.json.
//
//   bun tools/jira-record/record.ts <home> <step> <site> <ctl command> '<args JSON>'
//
// <home> is a scratch COLLIE_HOME kept between steps. Credentials come from the collie-jira
// keychain item, as the controller reads them. Scrubbing: the site becomes [SITE], the cloud
// id [CLOUD-ID], issue keys in KEYS become TST-n; avatars, icons, self links and account ids
// are dropped. Request headers (Authorization) are never recorded.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newUlid } from "@collie/schema";
import { Controller } from "../../packages/controller/src/controller.ts";
import { keychainJira } from "../../packages/controller/src/credentials.ts";
import { Home, writeJsonAtomic } from "../../packages/controller/src/home.ts";
import { fetchHttp, type Http, JiraClient } from "../../packages/controller/src/jira.ts";

const [homeDir, step, site, command, argsJson] = process.argv.slice(2);
if (!homeDir || !step || !site || !command || !argsJson) {
  console.error("usage: record.ts <home> <step> <site> <command> '<args JSON>'");
  process.exit(2);
}
const MAP: Record<string, string> = JSON.parse(process.env.KEY_MAP ?? "{}");
const OUT = join(import.meta.dir, "../../fixtures/jira");

type Exchange = {
  request: { method: string; url: string; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
};
const exchanges: Exchange[] = [];
let cloudId = "";

function scrubText(s: string): string {
  let out = s.split(site as string).join("[SITE].atlassian.net");
  if (cloudId) out = out.split(cloudId).join("[CLOUD-ID]");
  for (const [from, to] of Object.entries(MAP)) out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  return out;
}

const DROP = new Set(["self", "iconUrl", "avatarUrls", "accountId", "emailAddress", "expand"]);
function scrubJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubJson);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !DROP.has(k))
        .map(([k, x]) => [k, scrubJson(x)]),
    );
  }
  return typeof v === "string" ? scrubText(v) : v;
}

const recording: Http = async (req) => {
  const res = await fetchHttp(req);
  if (req.url.endsWith("/_edge/tenant_info") && res.status === 200) cloudId = JSON.parse(res.body).cloudId;
  const parse = (b: string | undefined) => {
    if (b === undefined) return null;
    try {
      return JSON.parse(b);
    } catch {
      return b;
    }
  };
  exchanges.push({
    request: { method: req.method, url: scrubText(req.url), body: scrubJson(parse(req.body)) },
    response: {
      status: res.status,
      headers: Object.fromEntries(
        Object.entries(res.headers).filter(([k]) => k === "content-type" || k === "x-failure-category"),
      ),
      body: scrubJson(parse(res.body)),
    },
  });
  return res;
};

const home = new Home(homeDir);
home.ensureLayout();
const c = new Controller(
  home,
  { now: () => Date.now(), id: () => newUlid() },
  (m) => console.error(`log: ${m}`),
  new JiraClient(recording, keychainJira()),
);
c.recover();
// The cloud id of a board made in an earlier step, so later steps scrub it too.
try {
  cloudId = JSON.parse(readFileSync(join(homeDir, "cloud_id"), "utf8"));
} catch {}

const id = newUlid();
writeJsonAtomic(join(home.pending, `${id}.json`), {
  v: 1,
  id,
  command,
  at: new Date().toISOString(),
  args: JSON.parse(argsJson),
});
await c.processCommands();
c.flushAll();
const reply = JSON.parse(readFileSync(join(home.done, `${id}.json`), "utf8"));
if (cloudId) writeFileSync(join(homeDir, "cloud_id"), JSON.stringify(cloudId));
mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, `${step}.json`),
  `${JSON.stringify({ step, command, args: scrubJson(JSON.parse(argsJson)), exchanges }, null, 2)}\n`,
);
console.log(JSON.stringify(scrubJson(reply)));
