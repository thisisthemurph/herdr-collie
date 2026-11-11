// The Cursor adapter (docs/plan.md, Phase 7: "a second harness profile"). Cursor's CLI is
// `agent` (Cursor Agent): `agent [prompt...]` starts an interactive session with the prompt as
// its first message, and `--model <model>` picks the model (https://cursor.com/docs/cli/reference/parameters).
//
// DECISION: that page lists no flag for a system prompt or rules file, so the profile's
// instructions and the reporting block go in front of the first message, in the prompt. The
// one-line first message follows them.
// DECISION: the binary is looked for as `cursor-agent` first (the name the installer has used and
// that third-party guides still give), then `agent`, or at $COLLIE_CURSOR. `agent` is a generic
// name, so it is the fallback.
// UNVERIFIED: this adapter has never launched a real Cursor Agent (CLAUDE.md: tests that need
// one are opt-in), and nothing here sets how Herdr's `hc` reads its turn ending. Run the Cursor
// entry of docs/manual-acceptance.md before relying on it.
import { type Adapter, AdapterError } from "./types.ts";

export const resolveCursor = (name: string): string | null =>
  process.env.COLLIE_CURSOR || Bun.which(name) || null;

export function cursor(resolve: (name: string) => string | null = resolveCursor): Adapter {
  return {
    name: "cursor",
    launch({ profile, systemPrompt, firstMessage }) {
      const bin = resolve("cursor-agent") ?? resolve("agent");
      if (!bin) {
        throw new AdapterError(
          "couldn't find Cursor's `agent` (or `cursor-agent`) on the controller's PATH. Install the Cursor CLI, or set COLLIE_CURSOR to its full path, and retry",
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
