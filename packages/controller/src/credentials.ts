// Credentials from the macOS keychain, read at the moment of use (CLAUDE.md, "Secrets").
// The token is read with `security find-generic-password -w`, so it travels on that child's
// stdout into memory only: never a command line, file, log, event or agent environment.
import { CommandError } from "./controller.ts";

export type JiraCredentials = { email: string; token: string };
export type CredentialSource = { jira(): Promise<JiraCredentials> };
/** The Bitbucket access token (Bearer). Read per request; never stored. */
export type TokenSource = { bitbucket(): Promise<string> };

export const JIRA_SERVICE = "collie-jira";
export const BITBUCKET_SERVICE = "collie-bitbucket";

export type Run = (args: string[]) => { code: number; stdout: string; stderr: string };

export const security: Run = (args) => {
  const p = Bun.spawnSync(["security", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

/**
 * The accounts of every generic-password item with this service name, from
 * `security dump-keychain` (attributes only: without -d it prints no secrets).
 */
export function keychainAccounts(service: string, run: Run = security): string[] {
  const r = run(["dump-keychain"]);
  if (r.code !== 0) throw new CommandError("internal", `could not list keychain items: ${r.stderr.trim()}`);
  const accounts: string[] = [];
  for (const block of r.stdout.split(/^keychain: /m)) {
    const svce = block.match(/"svce"<blob>="([^"]*)"/)?.[1];
    if (svce !== service || !/class: "genp"/.test(block)) continue;
    accounts.push(block.match(/"acct"<blob>="([^"]*)"/)?.[1] ?? "(no account)");
  }
  return accounts;
}

/** Reads the one Jira item: its account field is the email, its password the token. */
export function keychainJira(run: Run = security): CredentialSource {
  return {
    async jira() {
      const accounts = keychainAccounts(JIRA_SERVICE, run);
      if (accounts.length === 0) {
        throw new CommandError(
          "upstream_error",
          `no keychain item named ${JIRA_SERVICE}. Add one: security add-generic-password -s ${JIRA_SERVICE} -a <your Atlassian email> -w`,
        );
      }
      if (accounts.length > 1) {
        throw new CommandError(
          "upstream_error",
          `${accounts.length} keychain items are named ${JIRA_SERVICE} (accounts: ${accounts.join(", ")}); Collie can't tell which to use. Keep one and delete the others with security delete-generic-password -s ${JIRA_SERVICE} -a <account>`,
        );
      }
      const email = accounts[0] as string;
      const r = run(["find-generic-password", "-s", JIRA_SERVICE, "-a", email, "-w"]);
      const token = r.stdout.replace(/\n$/, "");
      if (r.code !== 0 || !token) {
        throw new CommandError(
          "upstream_error",
          `could not read the ${JIRA_SERVICE} keychain item for ${email}`,
        );
      }
      return { email, token };
    },
  };
}

/**
 * The Bitbucket access token: the password of the one `collie-bitbucket` item. Its account field
 * is free text, so it isn't used (a repository access token has no user).
 */
export function keychainBitbucket(run: Run = security): TokenSource {
  return {
    async bitbucket() {
      const accounts = keychainAccounts(BITBUCKET_SERVICE, run);
      if (accounts.length === 0) {
        throw new CommandError(
          "upstream_error",
          `no keychain item named ${BITBUCKET_SERVICE}. Add one: security add-generic-password -s ${BITBUCKET_SERVICE} -a collie -w  (paste a repository access token with pullrequest:write)`,
        );
      }
      if (accounts.length > 1) {
        throw new CommandError(
          "upstream_error",
          `${accounts.length} keychain items are named ${BITBUCKET_SERVICE} (accounts: ${accounts.join(", ")}); Collie can't tell which to use. Keep one and delete the others with security delete-generic-password -s ${BITBUCKET_SERVICE} -a <account>`,
        );
      }
      const r = run(["find-generic-password", "-s", BITBUCKET_SERVICE, "-a", accounts[0] as string, "-w"]);
      const token = r.stdout.replace(/\n$/, "");
      if (r.code !== 0 || !token) {
        throw new CommandError("upstream_error", `could not read the ${BITBUCKET_SERVICE} keychain item`);
      }
      return token;
    },
  };
}
