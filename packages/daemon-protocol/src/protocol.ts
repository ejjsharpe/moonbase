import { randomBytes } from 'node:crypto';
import { ApplicationError } from '@moonbase/contracts/workspace';
export { maximumChatRequestBytes, maximumChatReplyBytes } from '@moonbase/contracts/chat';
import { chatReplyErrorCodes } from '@moonbase/contracts/chat-schema';
import type { ChatHostEndpoint } from '@moonbase/contracts/services';
import {
  daemonErrorReasons,
  findDaemonErrorReason,
  readDaemonErrorReason,
} from '@moonbase/contracts/daemon';
import { fail } from './validation.ts';

/** Bounds one request: the client's wait for its reply and the health listener's request read. */
export const requestDeadlineMs = 20000;

export const nonce = () => randomBytes(32).toString('base64url');
export function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(value))
    return fail('InvalidInput', 'Configure a private chat host key.');
  return value;
}
export function origin(endpoint: ChatHostEndpoint): string {
  token(endpoint.token);
  try {
    const url = new URL(endpoint.origin);
    if (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {}
  return fail('InvalidInput', 'Chat transport requires an explicit 127.0.0.1 origin.');
}
export function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch {
    return fail('InvalidInput', 'Chat body must contain valid UTF-8 JSON.');
  }
}
export function publicError(error: unknown, operation?: string) {
  const code: (typeof chatReplyErrorCodes)[number] =
    ApplicationError.is(error) &&
    chatReplyErrorCodes.includes(error.code as (typeof chatReplyErrorCodes)[number])
      ? (error.code as (typeof chatReplyErrorCodes)[number])
      : 'Unavailable';
  const messages: Record<string, string> = {
    InvalidInput: 'Chat request is invalid or differs from its original identity.',
    Unauthorized: 'Chat request is not authorized.',
    Incompatible: 'Chat authority or protocol is incompatible.',
    Conflict: 'Chat is busy; retain this request and retry explicitly.',
    Persistence: 'Chat storage is unavailable; preserve pending input.',
    Uncertain: 'Chat outcome is uncertain; query its original request.',
    Unavailable: 'Chat host is unavailable.',
    Cancelled: 'Chat wait was cancelled.',
  };
  return {
    code,
    message:
      code === 'Conflict' && operation === 'getChatTranscriptContent'
        ? 'Transcript source changed; reload the selected content.'
        : messages[code],
  };
}
const daemonMessages: Record<(typeof chatReplyErrorCodes)[number], string> = {
  InvalidInput: 'The host refused this request as invalid.',
  Unauthorized: 'The host did not authorize this request.',
  Incompatible: 'The host’s authority or protocol is incompatible.',
  Conflict: 'The host is busy; retry explicitly.',
  Persistence: 'The host’s storage is unavailable.',
  Uncertain: 'The outcome is uncertain; check before retrying.',
  Unavailable: 'The host could not complete this request; retry.',
  Cancelled: 'The request was cancelled.',
};
/** The public form of a daemon operation's failure: its code and any reason clients can show. */
export function publicDaemonError(error: unknown) {
  const { code } = publicError(error),
    reason = ApplicationError.is(error) ? findDaemonErrorReason(error) : undefined;
  return reason
    ? { code, message: daemonErrorReasons[reason].message, reason }
    : { code, message: daemonMessages[code] };
}
/** Rebuilds a daemon failure from its code and named reason alone, with the client's own text. */
export function daemonFailure(code: (typeof chatReplyErrorCodes)[number], reason: unknown) {
  const known = readDaemonErrorReason(reason, code);
  return new ApplicationError({
    code,
    message: known ? daemonErrorReasons[known].message : daemonMessages[code],
  });
}
/** How a subscription reconnects after its connection drops. */
export const streamLimits = {
  // An authenticated message this long after a connection's first update proves it healthy and
  // renews its reconnect budget; half a heartbeat interval tolerates timer skew.
  renewMs: 5000,
  reconnectMs: [250, 500, 1000],
} as const;
