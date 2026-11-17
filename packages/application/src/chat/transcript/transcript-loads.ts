import { Effect } from 'effect';
import type { ChatTranscriptSelection, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { areJsonValuesEqual, getJsonKey } from '@moonbase/contracts/common';
import { describeChatFailure, isChatConflict } from '../chat-errors.ts';
import { TranscriptReadError } from './transcript-errors.ts';
import { manifestJob, type TranscriptJobs } from './transcript-jobs.ts';
import { appendManifestPage, findKnownParts, makeManifest } from './transcript-manifest.ts';
import { checkTranscriptReply, trackTranscriptCursor } from './transcript-read.ts';
import type { TranscriptStore } from './transcript-store.ts';

/**
 * What a transcript reads of one source on request: its manifest, a page at a time, and a selected
 * part's content, a chunk at a time. Their failures stay on their own state.
 */
export type TranscriptLoads = {
  readonly loadManifest: (source: ChatTranscriptSource, restart?: boolean) => Effect.Effect<void>;
  readonly loadPart: (
    source: ChatTranscriptSource,
    selection: ChatTranscriptSelection,
    restart?: boolean,
  ) => Effect.Effect<void>;
};

export function makeTranscriptLoads(store: TranscriptStore, jobs: TranscriptJobs): TranscriptLoads {
  let manifestAdvance = trackTranscriptCursor();
  const readContent = (input: Parameters<typeof checkTranscriptReply>[0]) =>
    store
      .read('getChatTranscriptContent', input, input.source)
      .pipe(Effect.map((reply) => checkTranscriptReply(input, reply)));
  /** Whether content for `source` is read to reveal the active Find match. */
  const isRevealing = (source: ChatTranscriptSource) =>
    store.state.find.revealing && areJsonValuesEqual(store.state.find.active?.source, source);
  const failedStatus = (error: unknown) => (isChatConflict(error) ? 'source-changed' : 'error');

  return {
    loadManifest: (source, restart = false) =>
      Effect.suspend(() => {
        const captured = structuredClone(source);
        const replace = restart || !areJsonValuesEqual(store.state.manifest?.source, captured);
        if (replace) {
          manifestAdvance = trackTranscriptCursor();
          store.state = { ...store.state, manifest: makeManifest(captured) };
        }
        const manifest = store.state.manifest!;
        if (manifest.status === 'complete' || manifest.status === 'source-changed')
          return Effect.void;
        const work = Effect.gen(function* () {
          store.state = {
            ...store.state,
            manifest: { ...manifest, status: 'loading', error: null },
          };
          yield* store.publish();
          const reply = yield* readContent({
            source: captured,
            ...(manifest.nextCursor ? { cursor: manifest.nextCursor } : {}),
          });
          if (reply.kind !== 'manifest')
            return yield* Effect.fail(new TranscriptReadError({ problem: 'expected-manifest' }));
          manifestAdvance(manifest.nextCursor, reply.nextCursor);
          const known = findKnownParts(captured, store.snapshot, store.history.records);
          store.state = { ...store.state, manifest: appendManifestPage(manifest, reply, known) };
        });
        return jobs.run(manifestJob, work, {
          replace,
          source: captured,
          revealing: isRevealing(captured),
          fail: (error) => {
            store.state = {
              ...store.state,
              manifest: {
                ...manifest,
                status: failedStatus(error),
                error: describeChatFailure(error),
              },
            };
          },
        });
      }),
    loadPart: (source, selection, restart = false) =>
      Effect.suspend(() => {
        const captured = structuredClone({ source, selection });
        const selected = captured.selection;
        const entryId = captured.source.kind === 'entry' ? captured.source.entryId : undefined;
        store.selectedEntry =
          store.history.findRecord(entryId) ??
          store.snapshot?.entries.find((entry) => entry.id === entryId);
        const key = getJsonKey([captured.source, selected]);
        const content = store.contents.open(key, captured.source, selected, restart);
        if (content.status === 'complete' || content.status === 'source-changed')
          return store.publish();
        const before = { ...content, chunks: [] };
        const work = Effect.gen(function* () {
          store.contents.mark(key, { status: 'loading', error: null }, before);
          yield* store.publish();
          const reply = yield* readContent({
            ...captured,
            ...(before.nextCursor ? { cursor: before.nextCursor } : {}),
          });
          if (reply.kind !== 'content')
            return yield* Effect.fail(new TranscriptReadError({ problem: 'chunk-gap' }));
          store.contents.append(key, before, reply);
        });
        return jobs.run(key, work, {
          replace: restart,
          source: captured.source,
          revealing: isRevealing(captured.source),
          fail: (error) =>
            store.contents.mark(
              key,
              { status: failedStatus(error), error: describeChatFailure(error) },
              before,
            ),
        });
      }),
  };
}
