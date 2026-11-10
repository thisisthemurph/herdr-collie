import type { Profile } from "@collie/schema";

export type LaunchInput = {
  profile: Profile;
  /** The profile's instructions plus the reporting block. */
  systemPrompt: string;
  /** The one-line first message. */
  firstMessage: string;
};

export type Launch = {
  /** The program and its arguments. */
  argv: string[];
  /** Environment the harness itself needs, besides the COLLIE_* variables. */
  env: Record<string, string>;
};

export type Adapter = {
  name: string;
  /** Throws AdapterError when the harness can't be started on this machine. */
  launch(input: LaunchInput): Launch;
};

export class AdapterError extends Error {}

export type Adapters = Record<string, Adapter>;
