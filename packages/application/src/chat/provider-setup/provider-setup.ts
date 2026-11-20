import { Cause, Exit, type Effect } from 'effect';
import type { ProviderState } from '@moonbase/contracts/providers';
import type { ProviderSetupPort } from '../chat-ports.ts';
import { describeChatFailure } from '../chat-errors.ts';

export type ProviderSetupSnapshot = {
  status: ProviderState | null;
  /** A command is running. */
  busy: boolean;
  error: string | null;
};
/** A command that started; its identity is what `ProviderSetupState` tracks. */
export type ProviderSetupCommand = { readonly read: boolean };
/** Provider setup's state: what a view shows, and what decides whose reply shows. */
export type ProviderSetupState = ProviderSetupSnapshot & {
  /** Commands that started and haven't settled; `busy` while any does. */
  active: ReadonlySet<ProviderSetupCommand>;
  /** The newest command: only its reply or error shows. */
  owner: ProviderSetupCommand | null;
  /** The open watch has delivered: it is the state's source and command replies stop replacing it. */
  watched: boolean;
};

type Call = ReturnType<ProviderSetupPort['getProviders']>;
/** How a command's call to the host ended. */
export type ProviderSetupReply = Exit.Exit<Effect.Success<Call>, Effect.Error<Call>>;

/** A command starts, unless it is a read and a mutation runs, whose reply is newer. */
export const startCommand = (
  s: ProviderSetupState,
  command: ProviderSetupCommand,
): ProviderSetupState | null =>
  command.read && [...s.active].some((other) => !other.read)
    ? null
    : { ...s, active: new Set([...s.active, command]), owner: command, busy: true, error: null };

/**
 * A command settles: it is no longer active, and its reply shows if it is still the newest
 * command, a failure as the error and a success as the status until the watch delivers.
 */
export const settleCommand = (
  s: ProviderSetupState,
  command: ProviderSetupCommand,
  reply: ProviderSetupReply,
): ProviderSetupState => {
  const active = new Set(s.active);
  active.delete(command);
  const settled = { ...s, active, busy: active.size > 0 };
  if (s.owner !== command) return settled;
  if (Exit.isSuccess(reply)) return s.watched ? settled : { ...settled, status: reply.value };
  return Cause.hasInterruptsOnly(reply.cause)
    ? settled
    : { ...settled, error: describeChatFailure(Cause.squash(reply.cause)) };
};
