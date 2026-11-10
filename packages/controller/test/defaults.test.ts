import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { validateProfile, validateWorkflow } from "@collie/schema";
import { DEFAULT_PROFILES, DEFAULT_WORKFLOWS, seedDefaults } from "../src/defaults.ts";
import { Home } from "../src/home.ts";
import { scratchHome } from "./helpers.ts";

test("every default profile and workflow is valid, and each workflow names profiles that exist", () => {
  for (const p of DEFAULT_PROFILES) expect(validateProfile(p)).toMatchObject({ ok: true });
  const ids = new Set(DEFAULT_PROFILES.map((p) => p.id));
  for (const w of DEFAULT_WORKFLOWS) {
    expect(validateWorkflow(w)).toMatchObject({ ok: true });
    for (const name of [w.developer, ...w.reviewers.map((r) => r.profile)]) expect(ids.has(name)).toBe(true);
  }
  expect(DEFAULT_WORKFLOWS.map((w) => w.id)).toEqual(["standard-feature", "small-bug-fix"]);
  expect(DEFAULT_WORKFLOWS[1]?.reviewers).toEqual([]);
});

test("defaults are saved when missing and never overwrite what is there", () => {
  const s = scratchHome();
  try {
    const home = new Home(`${s.root}/fresh`);
    home.ensureLayout();
    expect(seedDefaults(home)).toHaveLength(DEFAULT_PROFILES.length + DEFAULT_WORKFLOWS.length);
    // A person edits one; the next start leaves it alone.
    const path = home.workflow("standard-feature");
    const edited = { ...JSON.parse(readFileSync(path, "utf8")), max_remediation_rounds: 5 };
    writeFileSync(path, JSON.stringify(edited));
    expect(seedDefaults(home)).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).max_remediation_rounds).toBe(5);
  } finally {
    s.cleanup();
  }
});
