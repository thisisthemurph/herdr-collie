// Exit codes (docs/protocol.md, "CLI design").
export const EXIT = {
  ok: 0,
  /** Invalid arguments; the message says what to change. */
  invalid: 2,
  /** Not inside a Collie execution (environment missing). */
  env: 3,
  /** Execution already ended. */
  ended: 4,
  /** I/O error; safe to retry, the event id is reused. */
  io: 5,
} as const;

export class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export const invalid = (message: string) => new CliError(EXIT.invalid, message);
