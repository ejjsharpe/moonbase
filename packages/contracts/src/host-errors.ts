import * as Schema from 'effect/Schema';
import type { ErrorGroup } from './error-groups.ts';
import { UnauthorizedError, type UncertainError } from './errors.ts';
import type { ConnectionFailure } from './connection-errors.ts';

// What a chat host (the daemon) and the clients of its RPC link fail with, apart from what each of
// its services does (epic #273 D14). A request for another host is the shared `UnauthorizedError`
// and a mutation whose outcome is unknown the shared `UncertainError`. Every message here is built
// from fixed text and literal fields, so an error decoded from a host carries no text it wrote (D11).

const unavailable = {
  stopping: 'The daemon is stopping.',
  busy: 'Too many requests are in flight; retry.',
  failed: 'Chat host is unavailable.',
  closed: 'The daemon connection closed.',
  refused: 'The daemon refused the connection.',
  unreachable: 'The daemon could not be reached.',
  'watch-ended': 'The watch ended.',
  'reply-lost': 'The reply was lost. Retry the read through the selected authority.',
  'generation-changed':
    'Connection generation changed; query through the selected authority again.',
  listener: 'Chat host could not acquire its loopback listener or backing service.',
} as const;
/** The host, or the connection to it, could not answer: nothing was applied, so a read may retry. */
export class HostUnavailableError extends Schema.TaggedError<HostUnavailableError>()(
  'HostUnavailableError',
  { reason: Schema.Literals(Object.keys(unavailable) as (keyof typeof unavailable)[]) },
) {
  get group(): ErrorGroup {
    return 'unavailable';
  }
  override get message() {
    return unavailable[this.reason];
  }
}

const incompatibilities = {
  'not-served': 'This host does not serve that operation.',
  'not-daemon': 'This host does not run the Moonbase daemon. Update it.',
  'invalid-reply': 'The daemon sent an invalid reply.',
  'invalid-update': 'The daemon sent an invalid update.',
  'no-roots': 'This host has no approved roots to list.',
  'host-chat-projects': 'A host’s chats can’t become projects.',
  runtime:
    'The Pi host requires Node 26.13 or newer, or exactly Bun 1.4.4. The remote client has its own runtime boundary.',
} as const;
/** The host does not offer what was asked, or answered in a way this client cannot use. */
export class IncompatibleHostError extends Schema.TaggedError<IncompatibleHostError>()(
  'IncompatibleHostError',
  {
    reason: Schema.Literals(Object.keys(incompatibilities) as (keyof typeof incompatibilities)[]),
  },
) {
  get group(): ErrorGroup {
    return 'incompatible';
  }
  override get message() {
    return incompatibilities[this.reason];
  }
}

/** The host's key appears in its public identity or settings, so the host does not serve. */
export class HostKeyExposedError extends Schema.TaggedError<HostKeyExposedError>()(
  'HostKeyExposedError',
  {},
) {
  get group(): ErrorGroup {
    return 'refusal';
  }
  override get message() {
    return 'Keep the private host key separate from public chat identities and settings.';
  }
}

/** A mutation's request ID already names a request with another operation or input. */
export class RequestReusedError extends Schema.TaggedError<RequestReusedError>()(
  'RequestReusedError',
  {},
) {
  get group(): ErrorGroup {
    return 'refusal';
  }
  override get message() {
    return 'Request ID is already bound to another operation or input.';
  }
}

/**
 * What any RPC procedure of a host can fail with, whatever service answers it: a refused admission
 * or a failed handler, a request for another host, an operation the host does not serve.
 */
export const hostErrors = [HostUnavailableError, UnauthorizedError, IncompatibleHostError] as const;
/**
 * What a service reached over a daemon link fails with besides its own errors: the host's shared
 * errors, a mutation whose reply was lost, and the link's connection failures.
 */
export type DaemonLinkError =
  | InstanceType<(typeof hostErrors)[number]>
  | UncertainError
  | RequestReusedError
  | ConnectionFailure;
