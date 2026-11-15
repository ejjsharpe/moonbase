import { hostTokenPattern } from '@moonbase/contracts/host';
import { randomBytes } from 'node:crypto';
import { ApplicationError } from '@moonbase/contracts/workspace';
export { maximumChatRequestBytes, maximumChatReplyBytes } from '@moonbase/contracts/chat';
import { chatReplyErrorCodes } from '@moonbase/contracts/chat-schema';
import type { ChatHostEndpoint } from '@moonbase/contracts/services';
import { fail } from '@moonbase/contracts/errors';

/** Bounds one request: the client's wait for its reply and the health listener's request read. */
export const requestDeadlineMs = 20000;

export const nonce = () => randomBytes(32).toString('base64url');
export function token(value: unknown): string {
  if (typeof value !== 'string' || !hostTokenPattern.test(value))
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
type PublicCode = (typeof chatReplyErrorCodes)[number];
const messages: Record<PublicCode, string> = {
  InvalidInput: 'Chat request is invalid or differs from its original identity.',
  Unauthorized: 'Chat request is not authorized.',
  Incompatible: 'Chat authority or protocol is incompatible.',
  Conflict: 'Chat is busy; retain this request and retry explicitly.',
  Persistence: 'Chat storage is unavailable; preserve pending input.',
  Uncertain: 'Chat outcome is uncertain; query its original request.',
  Unavailable: 'Chat host is unavailable.',
  Cancelled: 'Chat wait was cancelled.',
};
/** A failure's public code, with the fixed text clients show for it. */
export const publicFailure = (code: PublicCode) => ({ code, message: messages[code] });
/** The public form of a legacy socket failure: its `ApplicationError` code, else `Unavailable`. */
export function publicError(error: unknown) {
  return publicFailure(
    ApplicationError.is(error) && chatReplyErrorCodes.includes(error.code as PublicCode)
      ? (error.code as PublicCode)
      : 'Unavailable',
  );
}
const daemonMessages: Record<PublicCode, string> = {
  InvalidInput: 'The host refused this request as invalid.',
  Unauthorized: 'The host did not authorize this request.',
  Incompatible: 'The host’s authority or protocol is incompatible.',
  Conflict: 'The host is busy; retry explicitly.',
  Persistence: 'The host’s storage is unavailable.',
  Uncertain: 'The outcome is uncertain; check before retrying.',
  Unavailable: 'The host could not complete this request; retry.',
  Cancelled: 'The request was cancelled.',
};
/** The public form of a file host operation's failure on the legacy socket: its code alone. */
export function publicDaemonError(error: unknown) {
  const { code } = publicError(error);
  return { code, message: daemonMessages[code] };
}
/** Rebuilds a file host failure from its code alone, with the client's own text. */
export function daemonFailure(code: PublicCode) {
  return new ApplicationError({ code, message: daemonMessages[code] });
}
/** How a subscription reconnects after its connection drops. */
export const streamLimits = {
  // An authenticated message this long after a connection's first update proves it healthy and
  // renews its reconnect budget; half a heartbeat interval tolerates timer skew.
  renewMs: 5000,
  reconnectMs: [250, 500, 1000],
} as const;
