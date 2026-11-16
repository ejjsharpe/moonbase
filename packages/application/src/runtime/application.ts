import * as Schema from 'effect/Schema';
import type { Effect } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatDependencies } from '../chat/index.ts';

/** A chat host the user can switch to, acquired when it is opened. */
export type NamedChatTarget = {
  id: string;
  label: string;
  acquire: Effect.Effect<ChatDependencies | null, unknown>;
};
export type ApplicationPhase = 'live' | 'preparing' | 'prepared' | 'disposing' | 'disposed' | 'failed';
export type ApplicationChatStatus =
  | 'unavailable'
  | 'opening'
  | 'ready'
  | 'closed'
  | 'initialization-failed'
  | 'cleanup-blocked';
export type MoonbaseApplicationSnapshot = {
  phase: ApplicationPhase;
  chat: { state: ApplicationChatStatus; error: string | null };
  chatTargets: readonly { id: string; label: string }[];
  chatTargetId: string | null;
  cleanup: { pending: readonly string[]; errors: readonly string[] };
};

const reasons = {
  closing: 'Application is closing.',
  'target-unavailable': 'Chat target is unavailable or another selection is pending.',
  'preserve-first': 'Preserve the current chat before switching targets.',
  'cleanup-pending': 'Chat still owns unfinished cleanup. Quit and recover before reopening it.',
  unavailable: 'Chat is unavailable.',
  'invalid-targets':
    'Supply distinct named chat targets and a matching default, or the single chat capability.',
} as const;

/** What the application's composition refused or could not do. */
export class ApplicationLifecycleError extends Schema.TaggedError<ApplicationLifecycleError>()(
  'ApplicationLifecycleError',
  { reason: Schema.Literals(Object.keys(reasons) as (keyof typeof reasons)[]) },
) {
  override get message(): string {
    return reasons[this.reason];
  }
}

/** Whether the chat targets are distinct and named, with a matching default. */
export const areChatTargetsValid = (
  targets: readonly NamedChatTarget[],
  defaultChatTargetId: string | undefined,
) =>
  new Set(targets.map((target) => target.id)).size === targets.length &&
  targets.every((target) => /^[A-Za-z0-9._:-]{1,256}$/.test(target.id) && target.label.trim()) &&
  (!defaultChatTargetId || targets.some((target) => target.id === defaultChatTargetId));

/** A failure's text as the application shows it: its own message, else fixed text. */
export function describeApplicationFailure(error: unknown) {
  if (ApplicationError.is(error)) return error.message;
  if (error instanceof Error && typeof (error as { _tag?: unknown })._tag === 'string')
    return error.message;
  return 'Application effect failed';
}

/** Several failures as one alert, at most 512 characters. */
export const joinFailures = (errors: readonly unknown[]) =>
  errors.map(describeApplicationFailure).join('; ').slice(0, 512);
