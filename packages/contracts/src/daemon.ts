import type { Effect } from 'effect';
import type { FolderError, FolderRefusal } from './folder-errors.ts';
import type * as Contracts from './daemon-schema.ts';

/** A daemon's folder and control operations. */
export type LocalHostCommand = keyof typeof Contracts.localHostInputSchemas;
export type LocalHostInput<K extends LocalHostCommand> =
  (typeof Contracts.localHostInputSchemas)[K]['Type'];
export type LocalHostOutput<K extends LocalHostCommand> =
  (typeof Contracts.localHostOutputSchemas)[K]['Type'];
/** Provider setup as a host serves it: each operation names its host and owner. */
export type HostProviderCommand = keyof typeof Contracts.hostProviderInputSchemas;
/** Every operation a local-mode daemon serves beyond `ChatCommand`. */
export type DaemonCommand = LocalHostCommand | HostProviderCommand;
export type DaemonInput<K extends DaemonCommand> = (typeof Contracts.daemonInputSchemas)[K]['Type'];
export type DaemonOutput<K extends DaemonCommand> =
  (typeof Contracts.daemonOutputSchemas)[K]['Type'];

/**
 * Which working folders a daemon's chats may use, and how a client chooses one. Folders that can't
 * be checked are not ones chats may use: `has` answers false, never fails.
 */
export type FolderApprovals = {
  /** Whether `path` is exactly a folder chats may use, still the directory it was. */
  has(path: string): Effect.Effect<boolean>;
  /** Approves a folder a client chose, returning its real path; refuses one chats may not use. */
  approve(path: string, options?: { recent?: boolean }): Effect.Effect<string, FolderError>;
  /** Marks an approved folder as just used. */
  touch(path: string): Effect.Effect<void>;
  /** Recently used approved folders, newest first. */
  listRecent(): Effect.Effect<string[]>;
  /** The folders a client with no native picker chooses from; absent where it has one. */
  listFolders?(): Effect.Effect<string[]>;
  /** Why a folder chats may not use is refused. */
  refusal: Extract<FolderRefusal, 'not-approved' | 'outside-roots'>;
};
