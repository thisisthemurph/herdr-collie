// The Codex adapter (docs/plan.md, Phase 7: "a second harness profile"). Codex is OpenAI's coding
// agent CLI: `codex [OPTIONS] [PROMPT]` starts an interactive session with PROMPT as its first
// message, and `--model` picks the model.
//
// DECISION: Codex has no flag to append to its system prompt, so the profile's instructions and
// the reporting block go in front of the first message, in the prompt. Everything an agent needs
// to know is still in what it is first told; the one-line first message follows them.
// UNVERIFIED: this adapter has never launched a real Codex (CLAUDE.md: tests that need one are
// opt-in). Run the Codex entry of docs/manual-acceptance.md before relying on it.
import { type Adapter, AdapterError } from "./types.ts";

/** `codex` is found on the controller's PATH, or at $COLLIE_CODEX (hc run expands no aliases). */
export const resolveCodex = (name: string): string | null =>
  process.env.COLLIE_CODEX || Bun.which(name) || null;

export function codex(resolve: (name: string) => string | null = resolveCodex): Adapter {
  return {
    name: "codex",
    launch({ profile, systemPrompt, firstMessage }) {
      const bin = resolve("codex");
      if (!bin) {
        throw new AdapterError(
          "couldn't find `codex` on the controller's PATH. Install Codex, or set COLLIE_CODEX to its full path, and retry",
        );
      }
      return {
        // The prompt comes before any option, for the same reason as in the Claude Code adapter.
        argv: [bin, `${systemPrompt}\n\n${firstMessage}`, "--model", profile.model, ...profile.args],
        env: {},
      };
    },
  };
}
