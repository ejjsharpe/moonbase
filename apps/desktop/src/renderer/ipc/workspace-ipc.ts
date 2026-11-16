import { Effect, Layer, Stream } from 'effect';
import { WorkspaceService, type WorkspaceServiceShape } from '@moonbase/contracts/services';
import { workspaceInputSchemas } from '@moonbase/contracts/workspace-schema';
import { recoveryInputSchemas } from '@moonbase/contracts/recovery-schema';
import type { DesktopIpc } from './desktop-ipc.ts';
import { callEffect, watchStream, type Payload, type Tag } from './ipc-failures.ts';

const refused = 'Invalid workspace input.';
const operations = [...Object.keys(workspaceInputSchemas), ...Object.keys(recoveryInputSchemas)];

/**
 * The renderer's `WorkspaceService`: each command and watch is main's editor procedure over this
 * document's IPC port, failing with the legacy `ApplicationError` main sends.
 */
export const WorkspaceIpcLive = Layer.effect(
  WorkspaceService,
  Effect.gen(function* () {
    const context = yield* Effect.context<DesktopIpc>();
    const call = (tag: string) => (input: unknown) =>
      callEffect(tag as Tag, input as Payload<Tag>, refused).pipe(Effect.provideContext(context));
    return {
      ...Object.fromEntries(operations.map((operation) => [operation, call(operation)])),
      watch: (input) =>
        watchStream('watchWorkspace', input, refused).pipe(Stream.provideContext(context)),
      watchRecovery: (input) =>
        watchStream('watchRecovery', input, refused).pipe(Stream.provideContext(context)),
    } as WorkspaceServiceShape;
  }),
);
