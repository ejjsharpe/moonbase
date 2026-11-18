import { Effect, Layer, Stream } from 'effect';
import {
  WorkspaceService,
  type WorkspaceServiceShape,
} from '@moonbase/contracts/workspace-service';
import { workspaceInputSchemas } from '@moonbase/contracts/workspace-schema';
import { recoveryInputSchemas } from '@moonbase/contracts/recovery-schema';
import type { DesktopIpc } from './desktop-ipc.ts';
import { callEffect, watchStream, type Payload, type Refusal, type Tag } from './ipc-failures.ts';

const refused: Refusal = 'workspace-request';
const operations = [...Object.keys(workspaceInputSchemas), ...Object.keys(recoveryInputSchemas)];

/**
 * The renderer's `WorkspaceService`: each command and watch is main's editor procedure over this
 * document's IPC port, failing with the error main sends or the renderer's own (desktop IPC's
 * errors, which the application reads as well as the workspace's).
 */
export const WorkspaceIpcLive = Layer.effect(
  WorkspaceService,
  Effect.gen(function* () {
    const context = yield* Effect.context<DesktopIpc>();
    const call = (tag: string) => (input: unknown) =>
      callEffect(tag as Tag, input as Payload<Tag>, refused).pipe(Effect.provideContext(context));
    return {
      ...Object.fromEntries(operations.map((operation) => [operation, call(operation)])),
      watch: (input: Parameters<WorkspaceServiceShape['watch']>[0]) =>
        watchStream('watchWorkspace', input, refused).pipe(Stream.provideContext(context)),
      watchRecovery: (input: Parameters<WorkspaceServiceShape['watchRecovery']>[0]) =>
        watchStream('watchRecovery', input, refused).pipe(Stream.provideContext(context)),
    } as unknown as WorkspaceServiceShape;
  }),
);
