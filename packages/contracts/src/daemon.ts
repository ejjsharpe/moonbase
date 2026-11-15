import type { CommandOptions } from './common.ts';
import type { FolderRefusal } from './folder-errors.ts';
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
/** Privileged: a host's daemon operations, bound to its process root. */
export interface DaemonClient {
  command<K extends DaemonCommand>(
    operation: K,
    input: DaemonInput<K>,
    options?: CommandOptions,
  ): Promise<DaemonOutput<K>>;
}

/** Which working folders a daemon's chats may use, and how a client chooses one. */
export type FolderApprovals = {
  /** Whether `path` is exactly a folder chats may use, still the directory it was. */
  has(path: string): Promise<boolean>;
  /** Approves a folder a client chose, returning its real path; refuses one chats may not use. */
  approve(path: string, options?: { recent?: boolean }): Promise<string>;
  /** Marks an approved folder as just used. */
  touch(path: string): Promise<void>;
  /** Recently used approved folders, newest first. */
  listRecent(): Promise<string[]>;
  /** The folders a client with no native picker chooses from; absent where it has one. */
  listFolders?(): Promise<string[]>;
  /** Why a folder chats may not use is refused. */
  refusal: Extract<FolderRefusal, 'not-approved' | 'outside-roots'>;
};
