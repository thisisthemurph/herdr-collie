// Harness adapters: how to start one kind of agent (docs/protocol.md, "Agent profile").
// An adapter knows the harness's command line and quirks; the controller knows everything else.
import { claudeCode } from "./claude-code.ts";
import type { Adapters } from "./types.ts";

export * from "./types.ts";

export const defaultAdapters = (resolve?: (name: string) => string | null): Adapters => ({
  "claude-code": claudeCode(resolve),
});
