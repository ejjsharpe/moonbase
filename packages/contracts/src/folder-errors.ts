import * as Schema from 'effect/Schema';
import type { ErrorGroup } from './error-groups.ts';

// What a daemon's folder authority fails with (epic #273 D14): its `FolderApprovals`, the
// `LocalHostService` over them and the chat folder checks.

const refusals = {
  'not-approved': 'Choose this working folder with the native picker first.',
  'outside-roots': 'Choose a folder in one of the host’s approved roots.',
  'not-chat-folder': 'This chat’s folder is not one Moonbase made for it.',
} as const;
const uses = { chat: 'creating or retrying a local chat', search: 'searching its files' } as const;
/**
 * The folder is not one chats may use. A folder refused for a `use` (a new chat, or a file search)
 * says it needs approving first.
 */
export class FolderRefusedError extends Schema.TaggedError<FolderRefusedError>()(
  'FolderRefusedError',
  {
    refusal: Schema.Literals(Object.keys(refusals) as (keyof typeof refusals)[]),
    use: Schema.optional(Schema.Literals(Object.keys(uses) as (keyof typeof uses)[])),
  },
) {
  get group(): ErrorGroup {
    return 'access';
  }
  override get message() {
    return this.refusal === 'not-approved' && this.use
      ? `Approve this working folder before ${uses[this.use]}.`
      : refusals[this.refusal];
  }
}
export type FolderRefusal = FolderRefusedError['refusal'];

/** The folder a client chose does not exist, or is not a folder. */
export class FolderMissingError extends Schema.TaggedError<FolderMissingError>()(
  'FolderMissingError',
  {},
) {
  get group(): ErrorGroup {
    return 'refusal';
  }
  override get message() {
    return 'Choose an existing folder.';
  }
}

/** The approvals could not be read or checked. */
export class FoldersUnavailableError extends Schema.TaggedError<FoldersUnavailableError>()(
  'FoldersUnavailableError',
  {},
) {
  get group(): ErrorGroup {
    return 'unavailable';
  }
  override get message() {
    return 'Local folder approvals are unavailable.';
  }
}

const rootProblems = {
  'not-real-folder': 'Each approved root must be an existing folder named by its real path.',
  'holds-reserved': 'An approved root must not hold the daemon’s data or credential key.',
} as const;
/** A host-mode daemon's configured approved roots can't be used, so it does not start. */
export class InvalidRootsError extends Schema.TaggedError<InvalidRootsError>()(
  'InvalidRootsError',
  { problem: Schema.Literals(Object.keys(rootProblems) as (keyof typeof rootProblems)[]) },
) {
  get group(): ErrorGroup {
    return 'refusal';
  }
  override get message() {
    return rootProblems[this.problem];
  }
}

/** The error classes folder approvals fail with. */
export const folderErrors = [
  FolderRefusedError,
  FolderMissingError,
  FoldersUnavailableError,
] as const;
/** Every way a daemon's folder approvals fail. */
export type FolderError = InstanceType<(typeof folderErrors)[number]>;
/** Whether `value` is one of the folder approvals' errors. */
export const isFolderError: (value: unknown) => value is FolderError = Schema.is(
  Schema.Union(folderErrors),
);
