import * as Schema from 'effect/Schema';
import { ApplicationError } from '@moonbase/contracts/errors';

const reasons = {
  // What callers see.
  'older-daemon':
    'An older Moonbase daemon is still finishing its work. Local chat starts once it stops.',
  unreachable: 'Moonbase could not start or reach its local daemon. Retry; drafts are kept.',
  'still-stopping': 'The Moonbase chat daemon is still stopping. Try again shortly.',
  quitting: 'Moonbase is quitting.',
  // Why an attempt failed, as the log says; callers see `unreachable`.
  'data-folder': 'The local chat data folder is unavailable.',
  'spawn-failed': 'Moonbase could not start its local chat daemon.',
  'stopped-while-starting': 'The local chat daemon stopped while starting.',
  'start-timeout': 'The local chat daemon did not start in time.',
  'identity-unreadable': 'The local chat daemon’s identity is unreadable.',
} as const;
export type LocalDaemonErrorReason = keyof typeof reasons;

/** The local daemon could not be found, started, reached or stopped, for `reason`. */
export class LocalDaemonError extends Schema.TaggedError<LocalDaemonError>()('LocalDaemonError', {
  reason: Schema.Literals(Object.keys(reasons) as [LocalDaemonErrorReason]),
}) {
  override get message(): string {
    return reasons[this.reason];
  }
}

/**
 * The legacy `ApplicationError` for a local daemon failure: every one is `Unavailable`. Applied
 * where it reaches a consumer still on `ApplicationError` (the connection, chat, the editor's files).
 */
export const toDaemonApplicationError = (error: LocalDaemonError) =>
  new ApplicationError({ code: 'Unavailable', message: error.message });
