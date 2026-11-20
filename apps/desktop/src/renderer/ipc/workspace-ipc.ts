import { Effect, Layer, Stream } from 'effect';
import {
  WorkspaceService,
  type WorkspaceServiceShape,
} from '@moonbase/contracts/workspace-service';
import type { DesktopIpc } from './desktop-ipc.ts';
import { callEffect, watchStream, type Payload, type Refusal, type Tag } from './ipc-failures.ts';

const refused: Refusal = 'workspace-request';

/**
 * The renderer's `WorkspaceService`: each command and watch is main's editor procedure over this
 * document's IPC port, failing with the error main sends or the renderer's own (desktop IPC's
 * errors, which the application reads as well as the workspace's).
 */
export const WorkspaceIpcLive = Layer.effect(
  WorkspaceService,
  Effect.gen(function* () {
    const context = yield* Effect.context<DesktopIpc>();
    const call = <T extends Tag>(tag: T, input: Payload<T>) =>
      callEffect(tag, input, refused).pipe(Effect.provideContext(context));
    return {
      openCheckout: (input) => call('openCheckout', input),
      readFile: (input) => call('readFile', input),
      saveFile: (input) => call('saveFile', input),
      listDirectory: (input) => call('listDirectory', input),
      getIgnoredPaths: (input) => call('getIgnoredPaths', input),
      gitStatus: (input) => call('gitStatus', input),
      listWorktrees: (input) => call('listWorktrees', input),
      createWorktree: (input) => call('createWorktree', input),
      initializeRepository: (input) => call('initializeRepository', input),
      readComparison: (input) => call('readComparison', input),
      lookupFiles: (input) => call('lookupFiles', input),
      searchText: (input) => call('searchText', input),
      inspectEntries: (input) => call('inspectEntries', input),
      mutate: (input) => call('mutate', input),
      operationStatus: (input) => call('operationStatus', input),
      acknowledgeOperation: (input) => call('acknowledgeOperation', input),
      loadRecovery: (input) => call('loadRecovery', input),
      openTab: (input) => call('openTab', input),
      closeTab: (input) => call('closeTab', input),
      updateDraft: (input) => call('updateDraft', input),
      updateLayout: (input) => call('updateLayout', input),
      watch: (input) =>
        watchStream('watchWorkspace', input, refused).pipe(Stream.provideContext(context)),
      watchRecovery: (input) =>
        watchStream('watchRecovery', input, refused).pipe(Stream.provideContext(context)),
    } satisfies WorkspaceServiceShape;
  }),
);
