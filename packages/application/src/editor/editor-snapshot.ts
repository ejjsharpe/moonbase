import type {
  Comparison,
  DirectoryListing,
  GitStatus,
  OperationResult,
} from '@moonbase/contracts/workspace';
import type { SessionState } from './session/session-service.ts';
import type { EditorRecovery } from './recovery/recovery-layout.ts';
import type { OutboxState } from './recovery/recovery-outbox.ts';
import type { ViewsState } from './views/views.ts';
import type { BuffersState, EditorBuffer } from './buffers/buffers.ts';
import type { DiscoveryState } from './discovery/discovery.ts';
import { listUnsettled, type OperationsState } from './operations/operations.ts';
import type { MutationState, ReplacePrompt } from './mutation/mutation.ts';
import { isRecoveryReady, type ClosePrompt } from './unsaved-changes/unsaved-changes.ts';

/** The editor as a view shows it, read from each concept's state. */
export type EditorSnapshot = {
  ready: boolean;
  recoveryReady: boolean;
  disposed: boolean;
  closePrompt: ClosePrompt | null;
  holdingUnsaved: boolean;
  /** The checkout whose `initializeRepository` is running; it refuses saves and file operations. */
  initializing: string | null;
  recovery: EditorRecovery;
  buffers: readonly EditorBuffer[];
  comparisons: Readonly<Record<string, Comparison>>;
  listings: Readonly<Record<string, DirectoryListing>>;
  git: Readonly<Record<string, GitStatus>>;
  /** The last recovery edit failed; edits made since are not kept until a flush succeeds. */
  recoveryFailed: boolean;
  errors: readonly string[];
  operations: readonly OperationResult[];
  /** Whether a file operation is running, including while it asks. */
  mutating: boolean;
  replacePrompt: ReplacePrompt | null;
};

/** What each concept holds, which the snapshot is read from. */
export type EditorParts = {
  session: SessionState;
  alerts: readonly string[];
  views: ViewsState;
  buffers: BuffersState;
  discovery: DiscoveryState;
  operations: OperationsState;
  outbox: OutboxState;
  mutation: MutationState;
  closePrompt: ClosePrompt | null;
};

export const toEditorSnapshot = (parts: EditorParts): EditorSnapshot => ({
  ready: parts.session.ready,
  recoveryReady: isRecoveryReady(parts.session, parts.outbox, parts.buffers, parts.operations),
  disposed: parts.session.disposed,
  closePrompt: parts.closePrompt,
  holdingUnsaved: parts.session.holdingUnsaved,
  initializing: parts.session.initializing,
  recovery: parts.views.recovery,
  buffers: [...parts.buffers.buffers.values()],
  comparisons: parts.discovery.comparisons,
  listings: parts.discovery.listings,
  git: parts.discovery.git,
  recoveryFailed: parts.outbox.failure !== undefined,
  errors: parts.alerts,
  operations: listUnsettled(parts.operations),
  mutating: parts.mutation.mutating,
  replacePrompt: parts.mutation.replacePrompt,
});
