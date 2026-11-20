import * as Schema from 'effect/Schema';
import type { CancelledError } from './errors.ts';
import type { ErrorGroup } from './error-groups.ts';

// The errors a `ConnectionService` fails with. They belong to the port, since contracts imports
// no implementation: SSH, the loopback connection, desktop's own daemon and the daemon protocol's
// health check build them. Each reason has what it means for the request (its `group`) and its
// message, which is Moonbase's own; nothing from a remote host, a path or a cause reaches one (D11).

const connectionReasons = {
  closed: ['unavailable', 'The connection scope is closed.'],
  'observer-limit': [
    'unavailable',
    'Connection observer limit reached. Close an existing observation before subscribing.',
  ],
  'wrong-profile': ['refusal', 'Choose the configured SSH profile.'],
  'invalid-command': ['refusal', 'Invalid SSH command.'],
  'host-mismatch': ['conflict', 'Connection target does not match the configured host and store.'],
  'not-verified': ['unavailable', 'No verified connection is available for that host and store.'],
  'stale-generation': ['conflict', 'This disconnect names a stale connection generation.'],
  releasing: ['conflict', 'Previous SSH generation is still being released. Retry after teardown.'],
  'generation-exited': [
    'unavailable',
    'SSH generation exited and is being released. Retry after teardown.',
  ],
  'startup-deadline': [
    'unavailable',
    'SSH connection did not verify its independently running chat host before the startup deadline.',
  ],
  ended: ['unavailable', 'SSH connection ended before verification.'],
  'cleanup-failed': [
    'unavailable',
    'SSH connection ended before verification. A verification resource cleanup also failed.',
  ],
  platform: ['refusal', 'SSH process-group ownership requires a POSIX platform.'],
  'process-start': ['unavailable', 'Could not start the owned SSH process.'],
  'spawn-failed': [
    'unavailable',
    'Could not start system SSH. Verify the configured executable and its permissions.',
  ],
  'host-key': [
    'unavailable',
    'SSH host key verification failed. Have the operator verify the known host key before retrying.',
  ],
  'forward-bind': [
    'unavailable',
    'SSH could not bind its local forward. Another listener may have claimed the port; retry with a new connection.',
  ],
  authentication: [
    'access',
    'SSH authentication failed. Verify the configured SSH alias, agent and key access.',
  ],
  'output-overflow': [
    'unavailable',
    'SSH configuration output exceeded its bound. Use a focused connection profile.',
  ],
  exited: [
    'unavailable',
    'SSH exited. Check the configured alias, network, host key policy and independently running chat host.',
  ],
  'policy-forwards': [
    'refusal',
    'Configured SSH alias includes additional forwards. Use a dedicated alias without forwarding rules.',
  ],
  'policy-host-key': [
    'refusal',
    'Configured SSH policy disables host key checking. Use a verified host key policy.',
  ],
  'policy-host-authentication': [
    'refusal',
    'Configured SSH policy bypasses host authentication. Disable the bypass and verify the host key before connecting.',
  ],
  'policy-tunnel': [
    'refusal',
    'Configured SSH alias clears forwarding or requests a device tunnel. Use a dedicated loopback-forward profile.',
  ],
  'port-unavailable': ['unavailable', 'Could not reserve a local loopback port.'],
  'port-release': ['unavailable', 'Could not release the loopback port reservation.'],
  teardown: [
    'unavailable',
    'Owned SSH process group teardown failed. Retry release after resolving the process access failure.',
  ],
  // The loopback connection to this Mac's daemon, from its data directory.
  'data-directory': ['refusal', 'Supply the absolute path of the daemon data directory.'],
  label: ['refusal', 'Choose a short connection label.'],
  'loopback-profile': ['refusal', 'Choose the loopback connection profile.'],
  'daemon-mismatch': ['conflict', 'Connection target does not match the daemon’s host and store.'],
  'daemon-identity': ['incompatible', 'The daemon’s host or store identity changed.'],
  'daemon-protocol': ['incompatible', 'The daemon speaks another protocol version.'],
  'daemon-not-running': ['unavailable', 'The daemon is not running.'],
  'daemon-files-unsafe': [
    'unavailable',
    'The daemon data directory or one of its files is not private to this user.',
  ],
  'daemon-files-malformed': ['unavailable', 'The daemon’s connection files are malformed.'],
  'daemon-files-unreadable': ['unavailable', 'The daemon’s connection files could not be read.'],
} as const satisfies Record<string, readonly [ErrorGroup, string]>;
export type ConnectionErrorReason = keyof typeof connectionReasons;

/** A connection could not be opened, used or released, for `reason`. */
export class ConnectionError extends Schema.TaggedError<ConnectionError>()('ConnectionError', {
  reason: Schema.Literals(Object.keys(connectionReasons) as [ConnectionErrorReason]),
}) {
  get group(): ErrorGroup {
    return connectionReasons[this.reason][0];
  }
  override get message(): string {
    return connectionReasons[this.reason][1];
  }
}

const verificationReasons = {
  endpoint: ['refusal', 'Choose an explicit loopback chat endpoint.'],
  'endpoint-origin': [
    'refusal',
    'Chat endpoints must be plain 127.0.0.1 origins without credentials, paths or queries.',
  ],
  'endpoint-identity': ['refusal', 'Configure the expected chat host and store identities.'],
  'endpoint-key': ['refusal', 'Configure a valid host key outside the renderer.'],
  unreachable: ['unavailable', 'Chat host health could not be reached within its deadline.'],
  'read-failed': ['unavailable', 'Chat host health could not be read.'],
  rejected: ['access', 'Chat host rejected authentication.'],
  'request-rejected': ['access', 'Chat host rejected health authentication.'],
  unproved: ['access', 'Chat host did not prove the configured health identity.'],
  status: ['incompatible', 'Chat host health returned an unsuccessful status.'],
  'not-json': ['incompatible', 'Chat host health must be JSON.'],
  empty: ['incompatible', 'Chat host returned empty health data.'],
  'too-large': ['incompatible', 'Chat host health exceeds its size limit.'],
  malformed: ['incompatible', 'Chat host returned malformed health JSON.'],
  invalid: ['incompatible', 'Chat host returned invalid health data.'],
  identity: ['incompatible', 'Chat host or store identity does not match the configured target.'],
} as const satisfies Record<string, readonly [ErrorGroup, string]>;
export type HostVerificationReason = keyof typeof verificationReasons;

/** A chat host's signed health could not be checked, or did not prove the expected host. */
export class HostVerificationError extends Schema.TaggedError<HostVerificationError>()(
  'HostVerificationError',
  {
    reason: Schema.Literals(Object.keys(verificationReasons) as [HostVerificationReason]),
  },
) {
  get group(): ErrorGroup {
    return verificationReasons[this.reason][0];
  }
  override get message(): string {
    return verificationReasons[this.reason][1];
  }
}

const localDaemonReasons = {
  // What callers see.
  'older-daemon':
    'An older Moonbase daemon is still finishing its work. Local chat starts once it stops.',
  unreachable: 'Moonbase could not start or reach its local daemon. Retry; drafts are kept.',
  'reach-timeout': 'Moonbase could not reach its local daemon in time. Retry; drafts are kept.',
  'without-files':
    'The local daemon does not serve files yet. An older daemon is replaced once it has no work; Restart daemon replaces it now.',
  'still-stopping': 'The Moonbase chat daemon is still stopping. Try again shortly.',
  quitting: 'Moonbase is quitting.',
  // Why an attempt failed, as the log says.
  'data-folder': 'The local chat data folder is unavailable.',
  'spawn-failed': 'Moonbase could not start its local chat daemon.',
  'stopped-while-starting': 'The local chat daemon stopped while starting.',
  'start-timeout': 'The local chat daemon did not start in time.',
  'identity-unreadable': 'The local chat daemon’s identity is unreadable.',
} as const;
export type LocalDaemonErrorReason = keyof typeof localDaemonReasons;

/**
 * Desktop could not find, start, reach or stop this Mac's daemon, for `reason`; trying again may
 * succeed.
 */
export class LocalDaemonError extends Schema.TaggedError<LocalDaemonError>()('LocalDaemonError', {
  reason: Schema.Literals(Object.keys(localDaemonReasons) as [LocalDaemonErrorReason]),
}) {
  get group(): ErrorGroup {
    return 'unavailable';
  }
  override get message(): string {
    return localDaemonReasons[this.reason];
  }
}

/** What a `ConnectionService` fails with. */
export type ConnectionFailure =
  | ConnectionError
  | HostVerificationError
  | LocalDaemonError
  | CancelledError;
