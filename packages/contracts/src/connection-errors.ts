import * as Schema from 'effect/Schema';
import { ApplicationError, type ApplicationErrorCode, type CancelledError } from './errors.ts';

// The errors a `ConnectionService` fails with. They belong to the port, since contracts imports
// no implementation: SSH and the daemon protocol's health check build them. Every message is
// Moonbase's own; nothing from a remote host, a path or a cause reaches one (D11).

const connectionReasons = {
  closed: ['Unavailable', 'The connection scope is closed.'],
  'observer-limit': [
    'Unavailable',
    'Connection observer limit reached. Close an existing observation before subscribing.',
  ],
  'wrong-profile': ['InvalidInput', 'Choose the configured SSH profile.'],
  'host-mismatch': ['Conflict', 'Connection target does not match the configured host and store.'],
  'not-verified': ['Unavailable', 'No verified connection is available for that host and store.'],
  'stale-generation': ['Conflict', 'This disconnect names a stale connection generation.'],
  releasing: ['Conflict', 'Previous SSH generation is still being released. Retry after teardown.'],
  'generation-exited': [
    'Unavailable',
    'SSH generation exited and is being released. Retry after teardown.',
  ],
  'startup-deadline': [
    'Unavailable',
    'SSH connection did not verify its independently running chat host before the startup deadline.',
  ],
  ended: ['Unavailable', 'SSH connection ended before verification.'],
  'cleanup-failed': [
    'Unavailable',
    'SSH connection ended before verification. A verification resource cleanup also failed.',
  ],
  platform: ['InvalidInput', 'SSH process-group ownership requires a POSIX platform.'],
  'process-start': ['Unavailable', 'Could not start the owned SSH process.'],
  'spawn-failed': [
    'Unavailable',
    'Could not start system SSH. Verify the configured executable and its permissions.',
  ],
  'host-key': [
    'Unavailable',
    'SSH host key verification failed. Have the operator verify the known host key before retrying.',
  ],
  'forward-bind': [
    'Unavailable',
    'SSH could not bind its local forward. Another listener may have claimed the port; retry with a new connection.',
  ],
  authentication: [
    'Unauthorized',
    'SSH authentication failed. Verify the configured SSH alias, agent and key access.',
  ],
  'output-overflow': [
    'Unavailable',
    'SSH configuration output exceeded its bound. Use a focused connection profile.',
  ],
  exited: [
    'Unavailable',
    'SSH exited. Check the configured alias, network, host key policy and independently running chat host.',
  ],
  'policy-forwards': [
    'InvalidInput',
    'Configured SSH alias includes additional forwards. Use a dedicated alias without forwarding rules.',
  ],
  'policy-host-key': [
    'InvalidInput',
    'Configured SSH policy disables host key checking. Use a verified host key policy.',
  ],
  'policy-host-authentication': [
    'InvalidInput',
    'Configured SSH policy bypasses host authentication. Disable the bypass and verify the host key before connecting.',
  ],
  'policy-tunnel': [
    'InvalidInput',
    'Configured SSH alias clears forwarding or requests a device tunnel. Use a dedicated loopback-forward profile.',
  ],
  'port-unavailable': ['Unavailable', 'Could not reserve a local loopback port.'],
  'port-release': ['Unavailable', 'Could not release the loopback port reservation.'],
  teardown: [
    'Unavailable',
    'Owned SSH process group teardown failed. Retry release after resolving the process access failure.',
  ],
} as const satisfies Record<string, readonly [ApplicationErrorCode, string]>;
export type ConnectionErrorReason = keyof typeof connectionReasons;

/** A connection could not be opened, used or released, for `reason`. */
export class ConnectionError extends Schema.TaggedError<ConnectionError>()('ConnectionError', {
  reason: Schema.Literals(Object.keys(connectionReasons) as [ConnectionErrorReason]),
}) {
  override get message(): string {
    return connectionReasons[this.reason][1];
  }
}

const verificationReasons = {
  endpoint: ['InvalidInput', 'Choose an explicit loopback chat endpoint.'],
  'endpoint-origin': [
    'InvalidInput',
    'Chat endpoints must be plain 127.0.0.1 origins without credentials, paths or queries.',
  ],
  'endpoint-identity': ['InvalidInput', 'Configure the expected chat host and store identities.'],
  'endpoint-key': ['InvalidInput', 'Configure a valid host key outside the renderer.'],
  unreachable: ['Unavailable', 'Chat host health could not be reached within its deadline.'],
  'read-failed': ['Unavailable', 'Chat host health could not be read.'],
  rejected: ['Unauthorized', 'Chat host rejected authentication.'],
  'request-rejected': ['Unauthorized', 'Chat host rejected health authentication.'],
  unproved: ['Unauthorized', 'Chat host did not prove the configured health identity.'],
  status: ['Incompatible', 'Chat host health returned an unsuccessful status.'],
  'not-json': ['Incompatible', 'Chat host health must be JSON.'],
  empty: ['Incompatible', 'Chat host returned empty health data.'],
  'too-large': ['Incompatible', 'Chat host health exceeds its size limit.'],
  malformed: ['Incompatible', 'Chat host returned malformed health JSON.'],
  invalid: ['Incompatible', 'Chat host returned invalid health data.'],
  identity: ['Incompatible', 'Chat host or store identity does not match the configured target.'],
} as const satisfies Record<string, readonly [ApplicationErrorCode, string]>;
export type HostVerificationReason = keyof typeof verificationReasons;

/** A chat host's signed health could not be checked, or did not prove the expected host. */
export class HostVerificationError extends Schema.TaggedError<HostVerificationError>()(
  'HostVerificationError',
  {
    reason: Schema.Literals(Object.keys(verificationReasons) as [HostVerificationReason]),
  },
) {
  override get message(): string {
    return verificationReasons[this.reason][1];
  }
}

/**
 * What a `ConnectionService` fails with. `ApplicationError` remains for the implementations that
 * have not moved off it yet (the loopback connection and desktop's local daemon connection).
 */
export type ConnectionFailure =
  | ConnectionError
  | HostVerificationError
  | CancelledError
  | ApplicationError;

/**
 * The legacy `ApplicationError` for a connection failure, with the code it has always had. Applied
 * once, where a connection failure reaches a consumer still on `ApplicationError`.
 */
export function toConnectionApplicationError(error: ConnectionFailure): ApplicationError {
  switch (error._tag) {
    case 'ConnectionError':
      return new ApplicationError({
        code: connectionReasons[error.reason][0],
        message: error.message,
      });
    case 'HostVerificationError':
      return new ApplicationError({
        code: verificationReasons[error.reason][0],
        message: error.message,
      });
    case 'CancelledError':
      return new ApplicationError({ code: 'Cancelled', message: error.message });
    default:
      return error;
  }
}
