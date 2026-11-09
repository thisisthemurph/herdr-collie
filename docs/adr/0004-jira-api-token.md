# 0004 · Jira: scoped API token from the keychain, through api.atlassian.com

Status: accepted, 2026-11-09

## Decision

Authenticate to Jira Cloud with a scoped API token and the account's email (Basic auth),
both read from the OS keychain at the moment of use (service `collie-jira`; the account
field holds the email). Every call goes through
`https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…`; the board stores `cloud_id`,
looked up once from `https://{site}.atlassian.net/_edge/tenant_info`.

## Consequences

- The spike (`docs/spike.md` 6) showed a scoped token is rejected on the site URL, so the
  gateway is the only route.
- The token never reaches a command line, file, log, event or agent environment. The
  Basic header goes to the HTTP client in memory.
- Write-back names target statuses; Collie picks the matching transition per issue and
  logs `jira.writeback_skipped` when there is none.

## Alternative

An OAuth 2.0 (3LO) app: no personal token, but an app registration, a redirect flow and
refresh-token storage before the first call.
