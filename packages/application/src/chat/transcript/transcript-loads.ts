import { Effect } from 'effect';
import type {
  ChatOutput,
  ChatTranscriptMatch,
  ChatTranscriptSelection,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { areJsonValuesEqual, getJsonKey } from '@moonbase/contracts/common';
import { describeChatFailure, isChatConflict } from '../chat-errors.ts';
import { TranscriptReadError } from './transcript-errors.ts';
import { manifestJob, type TranscriptJobs } from './transcript-jobs.ts';
import { appendManifestPage, findKnownParts, makeManifest } from './transcript-manifest.ts';
import { checkTranscriptReply, trackTranscriptCursor } from './transcript-read.ts';
import type { TranscriptFailure, TranscriptStore } from './transcript-store.ts';

/**
 * What a transcript reads of one source on request: its manifest, a page at a time, and a selected
 * part's content, a chunk at a time. Their failures stay on their own state.
 */
export type TranscriptLoads = {
  readonly loadManifest: (source: ChatTranscriptSource, restart?: boolean) => Effect.Effect<void>;
  /**
   * A row's Load more parts: the next page of `source`'s manifest, reading its first page before it
   * when the manifest loaded is another source's (or none), and stopping there if that page failed
   * or is the last.
   */
  readonly loadMoreParts: (source: ChatTranscriptSource) => Effect.Effect<void>;
  /**
   * Reads `source`'s manifest again from its start, as a Find reveal does once its match's part was
   * released; true if `match` is still Find's active match once it has read.
   */
  readonly replayManifest: (
    source: ChatTranscriptSource,
    match: ChatTranscriptMatch | null,
  ) => Effect.Effect<boolean>;
  readonly loadPart: (
    source: ChatTranscriptSource,
    selection: ChatTranscriptSelection,
    restart?: boolean,
  ) => Effect.Effect<void>;
};

export function makeTranscriptLoads(store: TranscriptStore, jobs: TranscriptJobs): TranscriptLoads {
  let manifestAdvance = trackTranscriptCursor();
  /** Reads a source that is current as the read starts; a snapshot that makes it stale interrupts it. */
  const readContent = (input: Parameters<typeof checkTranscriptReply>[0]) =>
    Effect.suspend((): Effect.Effect<ChatOutput<'getChatTranscriptContent'>, TranscriptFailure> =>
      store.isCurrent(input.source)
        ? store.dependencies.chat.getChatTranscriptContent(input)
        : Effect.fail(new TranscriptReadError({ problem: 'source-changed' })),
    ).pipe(Effect.map((reply) => checkTranscriptReply(input, reply)));
  /** Whether content for `source` is read to reveal the active Find match. */
  const isRevealing = (source: ChatTranscriptSource) =>
    store.state.find.revealing && areJsonValuesEqual(store.state.find.active?.source, source);
  const failedStatus = (error: unknown) => (isChatConflict(error) ? 'source-changed' : 'error');
  const isManifestOf = (source: ChatTranscriptSource) =>
    areJsonValuesEqual(store.state.manifest?.source, source);

  const loadManifest: TranscriptLoads['loadManifest'] = (source, restart = false) =>
    Effect.suspend(() => {
      const captured = structuredClone(source);
      const replace = restart || !areJsonValuesEqual(store.state.manifest?.source, captured);
      if (replace) manifestAdvance = trackTranscriptCursor();
      // A replaced manifest is shown afresh once its read starts.
      const manifest = replace ? makeManifest(captured) : store.state.manifest!;
      if (manifest.status === 'complete' || manifest.status === 'source-changed')
        return Effect.void;
      const work = Effect.gen(function* () {
        yield* store.update((state) => ({
          ...state,
          manifest: { ...manifest, status: 'loading', error: null },
        }));
        const reply = yield* readContent({
          source: captured,
          ...(manifest.nextCursor ? { cursor: manifest.nextCursor } : {}),
        });
        if (reply.kind !== 'manifest')
          return yield* Effect.fail(new TranscriptReadError({ problem: 'expected-manifest' }));
        manifestAdvance(manifest.nextCursor, reply.nextCursor);
        const known = findKnownParts(
          captured,
          store.state.snapshot ?? undefined,
          store.history.records,
        );
        const next = appendManifestPage(manifest, reply, known);
        yield* store.update((state) => ({ ...state, manifest: next }));
      });
      return jobs.run(manifestJob, work, {
        replace,
        source: captured,
        revealing: isRevealing(captured),
        fail: (state, error) => ({
          ...state,
          manifest: { ...manifest, status: failedStatus(error), error: describeChatFailure(error) },
        }),
      });
    });
  return {
    loadManifest,
    loadMoreParts: (source) =>
      Effect.gen(function* () {
        if (!isManifestOf(source)) {
          yield* loadManifest(source);
          const first = store.state.manifest;
          if (first?.error || !first?.nextCursor || !isManifestOf(source)) return;
        }
        yield* loadManifest(source);
      }),
    replayManifest: (source, match) =>
      Effect.map(loadManifest(source, true), () => store.state.find.active === match),
    loadPart: (source, selection, restart = false) =>
      Effect.suspend(() => {
        const captured = structuredClone({ source, selection });
        const selected = captured.selection;
        const entryId = captured.source.kind === 'entry' ? captured.source.entryId : undefined;
        store.selectedEntry =
          store.history.findRecord(entryId) ??
          store.state.snapshot?.entries.find((entry) => entry.id === entryId);
        const key = getJsonKey([captured.source, selected]);
        const content = store.contents.open(key, captured.source, selected, restart);
        if (content.status === 'complete' || content.status === 'source-changed')
          return store.update();
        const before = { ...content, chunks: [] };
        const work = Effect.gen(function* () {
          store.contents.mark(key, { status: 'loading', error: null }, before);
          yield* store.update();
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
          fail: (state, error) => {
            store.contents.mark(
              key,
              { status: failedStatus(error), error: describeChatFailure(error) },
              before,
            );
            return state;
          },
        });
      }),
  };
}
