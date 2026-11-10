# Recorded Bitbucket exchanges

One file per call the controller makes (`packages/controller/src/bitbucket.ts`), played back by
`packages/controller/test/bitbucket.test.ts`. Workspace, repository and uuids are placeholders.

**Provenance:** the shapes follow the Bitbucket Cloud REST API 2.0 and what the Phase 0 spike saw on
a scratch repository (`docs/spike.md`, experiment 5: create a draft PR, retarget it with the draft
kept, mark it ready, read `participants`, and the scope headers). They were written by hand from
those results rather than captured, so when you run the Phase 6 demo against a real repository,
compare a real response with these and update them if a field differs.
