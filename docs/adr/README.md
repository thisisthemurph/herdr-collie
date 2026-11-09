# Architecture decision records

One short record per decision. A new decision gets the next number; a reversed one is
marked superseded and points at its replacement, never deleted.

| ADR | Decision |
| --- | --- |
| [0001](0001-typescript-on-bun.md) | TypeScript on Bun for the CLI and controller |
| [0002](0002-single-repo.md) | One repository for every part |
| [0003](0003-claude-code-first.md) | Claude Code is the only harness until Phase 7 |
| [0004](0004-jira-api-token.md) | Jira: scoped API token from the keychain, through api.atlassian.com |
| [0005](0005-bitbucket-cloud-only.md) | Bitbucket Cloud is the only code host |
| [0006](0006-fake-hc-and-fake-agent.md) | Test against a fake `hc` and a fake agent |
| [0007](0007-mod-starts-controller.md) | The mod starts the controller |
| [0008](0008-graph-view-from-scratch.md) | Build the dependency graph view from scratch |
