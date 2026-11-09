// Builds controller events with the shared envelope.
import type { AnyEvent } from "@collie/schema";

export type Clock = { now: () => number; id: () => string };

export type EventOpts = {
  ticket?: string | null;
  exec?: string | null;
  cause?: string | null;
  source?: "controller" | "human";
};

export function makeEvent(
  clock: Clock,
  runId: string,
  type: string,
  payload: Record<string, unknown>,
  o: EventOpts = {},
): AnyEvent {
  return {
    v: 1,
    id: clock.id(),
    type,
    ts: new Date(clock.now()).toISOString(),
    source: o.source ?? "controller",
    run_id: runId,
    execution_id: o.exec ?? null,
    ticket: o.ticket ?? null,
    caused_by: o.cause ?? null,
    payload,
  } as AnyEvent;
}
