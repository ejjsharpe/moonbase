import * as Schema from 'effect/Schema';
import type { ErrorGroup } from '@moonbase/contracts/error-groups';
import type { IpcError } from '@moonbase/contracts/ipc-errors';
import type { WorkspaceError } from '@moonbase/contracts/workspace-errors';

// What the editor itself refuses or reports (epic #273 D14): each reason names what happened and
// its message is Moonbase's own. `describeEditorFailure` in `alerts/` is the one place a failure
// becomes the text the editor shows.

const reasons = {
  'client-id': 'An editor requires its own nonempty recovery client ID.',
  closing: 'Application is closing.',
  closed: 'Editor disposed.',
  'not-ready': 'Load editor recovery first.',
  'checkout-not-open': 'This exact checkout is not open in this editor.',
  'foreign-recovery': 'Recovery belongs to another editor client.',
  'invalid-path': 'Use an exact relative path without traversal or .git.',
  'already-repository': 'This project is already a Git repository.',
  'initializing-already': 'Git is already being initialized. Wait for it to finish.',
  'initializing-other': 'Git initialized a different checkout. Reopen the folder.',
  'initializing-unfinished': 'Git was initialized, but the project did not finish moving to it:',
  initializing: 'Git is initializing in this project. Try again when it finishes.',
  'initializing-save': 'Git is initializing in this project. Save again when it finishes.',
  'initializing-close': 'Git is initializing. Close again when it finishes.',
  'rebind-busy': 'Wait for saves and file operations in this project to finish.',
  'checkout-identity': 'Checkout identity changed; retained work has not been rebound.',
  preserving: 'Finish the captured preservation action first.',
  'preserving-flush': 'Finish the captured preservation action before flushing.',
  'text-too-large': 'Editable text exceeds 2 MiB.',
  'not-open': 'Open this file before editing it.',
  'file-unavailable': 'File unavailable on disk. Retained buffer and edits remain accessible.',
  'comparison-unavailable': 'Comparison unavailable. Retained buffer and edits remain accessible.',
  'reveal-unavailable': 'Active file unavailable. Refresh and retry.',
  'reload-changed': 'The file changed while it was reloading. Edits retained; retry.',
  'save-uncertain': 'Resolve the pending file operation before saving this file.',
  'close-uncertain': 'Resolve pending file operations before closing their files.',
  'operation-submitted':
    'Operation already submitted. Resolve its status instead of dispatching it again.',
  'operation-pending': 'Resolve the pending operation on these entries before applying another.',
  'operation-checkout': 'A file operation must use one exact checkout.',
  'replacement-open':
    'Replacement has open buffers. Close them safely before replacing their files.',
  'source-saving': 'Resolve the source Save before moving or copying it.',
  'operation-identity': 'Operation response identity mismatch. Original pending evidence retained.',
  'operation-unconfirmed':
    'Operation outcome unconfirmed. Resolve status before taking further action.',
  'operation-unknown': 'Unknown operation.',
  'operation-status-unavailable':
    'Operation status unavailable; drafts and original references retained.',
  'operation-status-identity': 'Operation status identity mismatch.',
  /** The host reported a failure in its own words, which the editor never shows. */
  'host-reported': 'Application effect failed',
  'operation-checkout-identity':
    'Operation checkout identity unavailable or changed. Evidence and drafts retained without rebinding.',
} as const;
export type EditorErrorReason = keyof typeof reasons;

/** The reasons that refuse a request as given; `initializing-already` conflicts, the rest are unavailable. */
const refusals: ReadonlySet<EditorErrorReason> = new Set(['invalid-path', 'already-repository']);

/** What the editor refused or could not do, by reason. */
export class EditorError extends Schema.TaggedError<EditorError>()('EditorError', {
  reason: Schema.Literals(Object.keys(reasons) as EditorErrorReason[]),
  /** Moonbase's own text that completes the reason, never a host's. */
  detail: Schema.optional(Schema.String),
}) {
  get group(): ErrorGroup {
    if (refusals.has(this.reason)) return 'refusal';
    return this.reason === 'initializing-already' ? 'conflict' : 'unavailable';
  }
  override get message(): string {
    const text = reasons[this.reason];
    if (this.reason === 'initializing-unfinished')
      return `${text} ${this.detail ?? ''} Your tabs and drafts are kept on the repository.`;
    return text;
  }
}

export const isEditorError = (value: unknown): value is EditorError =>
  value instanceof Error && (value as { _tag?: unknown })._tag === 'EditorError';

/**
 * Every way an editor action fails: the editor's own refusals, the workspace's errors and, in a
 * window, desktop IPC's.
 */
export type EditorFailure = EditorError | WorkspaceError | IpcError;

// Each error declares its group, the editor's as well, so the editor asks `error-groups` too.
export { isRefusal, isUnavailable } from '@moonbase/contracts/error-groups';
