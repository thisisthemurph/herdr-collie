# {{ticket}} · {{summary}}

You are the {{profile_name}} on {{ticket}}.
Kind: {{kind}} · round {{round}} · attempt {{attempt}}

## Ticket
{{description}}
{{#acceptance_criteria}}

### Acceptance criteria
{{acceptance_criteria}}
{{/acceptance_criteria}}
{{#clarifications}}

### Clarifications
{{clarifications}}
{{/clarifications}}
{{#comments}}

### Recent Jira comments
{{comments}}
{{/comments}}

## Context
- Repository: {{repository}}
- Working directory: {{worktree}}
- Branch: {{branch_line}}
{{#stacked}}
- {{stacked}}
{{/stacked}}
{{#blocked_by}}
- Blocked by: {{blocked_by}}
{{/blocked_by}}
{{#blocks}}
- Blocks: {{blocks}}
{{/blocks}}

## Your task
{{kind_instructions}}
{{#findings}}

## {{findings_heading}}
{{findings}}
{{/findings}}

## Limits
{{limits}}
Time limit: {{timeout_min}} minutes.
