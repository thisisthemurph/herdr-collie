// @collie/schema: the single source of truth for every Collie file and event shape.
// Each `validateX` returns `{ ok: true, value }` or `{ ok: false, issues }`, where every issue
// names the field at fault (e.g. `payload.severity`). Use `formatIssues` for a one-line message.
import { type Command, type CommandReply, command, commandReply } from "./commands.ts";
import { type Board, board, type Profile, profile, type Workflow, workflow } from "./config.ts";
import {
  type AgentEvent,
  type AnyEvent,
  agentEvent,
  anyEvent,
  type ControllerEvent,
  controllerEvent,
} from "./events.ts";
import {
  type ControllerLock,
  controllerLock,
  type ExecutionFile,
  executionFile,
  type LeasesFile,
  leasesFile,
  type RunFile,
  runFile,
  type StateFile,
  stateFile,
} from "./runtime.ts";
import { type Result, runSchema } from "./validate.ts";

export * from "./commands.ts";
export * from "./common.ts";
export * from "./config.ts";
export * from "./events.ts";
export * from "./inbox.ts";
export * from "./runtime.ts";
export * from "./ulid.ts";
export { formatIssues, type Issue, type Result, runSchema, type Schema } from "./validate.ts";

export const validateAgentEvent = (v: unknown): Result<AgentEvent> => runSchema(agentEvent, v);
export const validateControllerEvent = (v: unknown): Result<ControllerEvent> => runSchema(controllerEvent, v);
export const validateEvent = (v: unknown): Result<AnyEvent> => runSchema(anyEvent, v);
export const validateCommand = (v: unknown): Result<Command> => runSchema(command, v);
export const validateCommandReply = (v: unknown): Result<CommandReply> => runSchema(commandReply, v);
export const validateProfile = (v: unknown): Result<Profile> => runSchema(profile, v);
export const validateWorkflow = (v: unknown): Result<Workflow> => runSchema(workflow, v);
export const validateBoard = (v: unknown): Result<Board> => runSchema(board, v);
export const validateRun = (v: unknown): Result<RunFile> => runSchema(runFile, v);
export const validateExecution = (v: unknown): Result<ExecutionFile> => runSchema(executionFile, v);
export const validateState = (v: unknown): Result<StateFile> => runSchema(stateFile, v);
export const validateLock = (v: unknown): Result<ControllerLock> => runSchema(controllerLock, v);
export const validateLeases = (v: unknown): Result<LeasesFile> => runSchema(leasesFile, v);

/** Validators by fixture kind, for tools and tests that check a file without knowing its type. */
export const VALIDATORS = {
  agent_event: validateAgentEvent,
  controller_event: validateControllerEvent,
  event: validateEvent,
  command: validateCommand,
  command_reply: validateCommandReply,
  profile: validateProfile,
  workflow: validateWorkflow,
  board: validateBoard,
  run: validateRun,
  execution: validateExecution,
  state: validateState,
  lock: validateLock,
  leases: validateLeases,
} as const;
export type ValidatorKind = keyof typeof VALIDATORS;
