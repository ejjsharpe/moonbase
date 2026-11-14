import { Effect, Layer, Stream } from 'effect';
import {
  WorkspaceService,
  type RecoveryEditHandlers,
  type WorkspaceServiceShape,
} from '@moonbase/contracts/services';
import { WorkspaceUnsupportedError } from '@moonbase/contracts/workspace-host-errors';

type RecoveryEditKeys = keyof RecoveryEditHandlers | 'watchRecovery';
/** A fake workspace that keeps whole recovery snapshots and none of the store's edits. */
export type SnapshotWorkspace = Omit<WorkspaceServiceShape, RecoveryEditKeys>;
const unsupported = () => new WorkspaceUnsupportedError({ feature: 'recovery-edits' });
const recoveryEdits = {
  openTab: () => Effect.fail(unsupported()),
  closeTab: () => Effect.fail(unsupported()),
  updateDraft: () => Effect.fail(unsupported()),
  updateLayout: () => Effect.fail(unsupported()),
  watchRecovery: () => Stream.fail(unsupported()),
} satisfies Pick<WorkspaceServiceShape, RecoveryEditKeys>;
/**
 * The `WorkspaceService` layer of a snapshot fake: the editor publishes whole snapshots until
 * CL-13 moves it to the recovery store's edits, so they fail as unsupported.
 */
export const snapshotWorkspaceLayer = (service: SnapshotWorkspace) =>
  Layer.succeed(WorkspaceService, { ...service, ...recoveryEdits });
