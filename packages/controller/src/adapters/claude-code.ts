// The Claude Code adapter (docs/protocol.md, "Agent profile"; settled by the Phase 0 spike).
import { type Adapter, AdapterError } from "./types.ts";

/**
 * DECISION: `claude` is found on the controller's PATH, or at $COLLIE_CLAUDE. hc run doesn't
 * expand shell aliases, and the spike's machine had `claude` as one, so the adapter needs a real
 * file path.
 */
export const resolveClaude = (name: string): string | null =>
  process.env.COLLIE_CLAUDE || Bun.which(name) || null;

export function claudeCode(resolve: (name: string) => string | null = resolveClaude): Adapter {
  return {
    name: "claude-code",
    launch({ profile, systemPrompt, firstMessage }) {
      const claude = resolve("claude");
      if (!claude) {
        throw new AdapterError(
          "couldn't find `claude` on the controller's PATH. Install Claude Code, or set COLLIE_CLAUDE to its full path, and retry",
        );
      }
      return {
        // The first message comes before any option: variadic options such as --allowedTools
        // swallow a trailing prompt without an error, and the agent sits idle at turn 0.
        argv: [
          claude,
          firstMessage,
          "--model",
          profile.model,
          "--append-system-prompt",
          systemPrompt,
          ...profile.args,
        ],
        // Background shells end the turn while work is still running, so hc would read `done`
        // early. Turning them off keeps "turn ended" honest.
        env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
      };
    },
  };
}
