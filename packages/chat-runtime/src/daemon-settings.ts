import * as S from './schema.ts';

/**
 * A daemon's optional `daemon.json`: a local-mode daemon (the default) with the source of its
 * credential key, or a host-mode daemon with its port, approved roots and credential key file.
 */
export type DaemonSettings = S.DaemonSettings;
/** Decodes `daemon.json` strictly; unknown fields are refused, and errors name no input. */
export const decodeDaemonSettings = (value: unknown): DaemonSettings => S.daemonSettings(value);
