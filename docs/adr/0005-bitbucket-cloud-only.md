# 0005 · Bitbucket Cloud is the only code host

Status: accepted, 2026-11-09

## Decision

Pull requests go to Bitbucket Cloud through `api.bitbucket.org/2.0`, with a repository,
project or workspace access token from the keychain (service `collie-bitbucket`) sent as a
Bearer token. Pushes use HTTPS with the same token through an in-memory credential helper
(user `x-token-auth`), never a token in the remote URL.

## Consequences

- The spike (`docs/spike.md` 5) confirmed draft PRs, changing the destination branch,
  marking ready and reading approvals.
- The API has no merge-conflict state. The controller checks with
  `git merge-tree --write-tree <destination> <source>` (git 2.38+) and logs
  `pr.conflict_checked`.
- A bot approving its own PR is accepted by the API but not counted by Bitbucket, so
  `approvals` counts only other people.
- No extra CLI dependency.

## Alternative

GitHub and other hosts later, behind a code-host interface.
