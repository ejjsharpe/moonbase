import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { EntryId, TaskInspection } from '@earendil-works/pi-durable';
import { Effect, FileSystem } from 'effect';
import { checkCanonicalFolder } from '../canonical-folder.ts';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import type {
  ChatHistoryPage,
  ChatRun,
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
} from '@moonbase/contracts/chat';
import { callHarness } from '../commands/harness-call.ts';
import { getScanCursorScope, writeScanCursor } from '../cursors.ts';
import { historyPageBytes } from '../page-limits.ts';
import { previewText } from '../text.ts';
import { captureTranscript, getLiveSource } from '../transcript/live-capture.ts';
import { projectLiveTranscript } from '../transcript/manifest.ts';
import { isNestedSourceEnded } from '../transcript/nested-calls.ts';
import { readHistory, type HistoryReader } from './history-page.ts';

/** Leading live tool slots a snapshot reads, more than its embedded transcript page reaches. */
const snapshotToolSlots = 8;

type BlockedReason = Extract<TaskInspection['state'], { kind: 'blocked' }>['reason'];
export type SnapshotCache = {
  statusVersion: number;
  retired?: boolean;
  boundary?: EntryId | null;
  history?: {
    boundary: string | null;
    page: ChatHistoryPage;
    continuations: (string | null)[];
  };
  status?: { taskId: string; blocked?: BlockedReason };
};
type SnapshotInput = {
  target: ChatTarget;
  conversation: ChatSummary;
  /** Pending Send intents recorded in metadata. */
  pending: number;
  cache?: SnapshotCache;
};
/** What a snapshot reads: history, and the platform's file system to check the chat's folder. */
export type SnapshotReader = HistoryReader & { fileSystem: FileSystem.FileSystem };
/** A chat's snapshot, read again (twice at most) when a nested tool's source ends under the read. */
export const projectSnapshot = (
  reader: SnapshotReader,
  input: SnapshotInput,
): Effect.Effect<ChatSnapshot, ChatError> =>
  projectSnapshotOnce(reader, input).pipe(Effect.retry({ times: 2, while: isNestedSourceEnded }));
const projectSnapshotOnce = (
  reader: SnapshotReader,
  { target, conversation, pending, cache }: SnapshotInput,
): Effect.Effect<ChatSnapshot, ChatError> =>
  Effect.gen(function* () {
    const { harness, identity } = reader;
    const captured = yield* captureTranscript(harness, target, {
      cache,
      toolSlots: snapshotToolSlots,
    });
    const { live, task, latest } = captured;
    let run: ChatRun | null = null,
      blocked: BlockedReason | undefined;
    if (live?.run) {
      const submissionId = live.run.inputs[0];
      let status = cache?.status;
      if (!status || status.taskId !== String(live.run.taskId)) {
        const version = cache?.statusVersion;
        const inspection = yield* callHarness(() => harness.inspect(context));
        const active = inspection.tasks.find((item) => item.record.id === live.run!.taskId);
        // An inspection from another control revision cannot describe this captured run.
        if (active && JSON.stringify(active.record) === JSON.stringify(task)) {
          const waiting = new Set<string>([String(active.record.id)]);
          for (let size = -1; size !== waiting.size;) {
            size = waiting.size;
            for (const item of inspection.tasks)
              if (waiting.has(String(item.record.id)) && item.state.kind === 'waiting')
                for (const id of item.state.on) waiting.add(String(id));
          }
          const stopped = inspection.tasks.find(
            (item) => waiting.has(String(item.record.id)) && item.state.kind === 'blocked',
          );
          status = {
            taskId: String(active.record.id),
            ...(stopped?.state.kind === 'blocked' ? { blocked: stopped.state.reason } : {}),
          };
          if (cache && cache.statusVersion === version) cache.status = status;
        }
      }
      blocked = status?.blocked;
      let runState: ChatRun['state'] = 'running';
      if (task?.abortRequested) runState = 'stopping';
      else if (live.generation?.deferred) runState = 'deferred';
      if (submissionId)
        run = {
          stop: { target, submissionId: String(submissionId), taskId: String(live.run.taskId) },
          state: runState,
          ...previewText(
            live.generation?.message?.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('') ?? '',
          ),
        };
    }
    let state: ChatSnapshot['state'];
    if (blocked) state = 'failed';
    else if (run) state = 'running';
    else if (pending) state = 'uncertain';
    else if (latest?.state.status === 'terminal' && latest.state.outcome.status === 'aborted')
      state = 'stopped';
    else if (latest?.state.status === 'terminal' && latest.state.outcome.status !== 'completed')
      state = 'failed';
    else state = 'idle';
    let message: string | undefined;
    if (blocked === 'restart_limit')
      message =
        'Pi parked this task after repeated interruption. Preserve its receipt and resolve the host failure.';
    else if (blocked)
      message =
        'Pi cannot run this task with the installed host definitions. Preserve its receipt and resolve the host configuration.';
    else if (pending)
      message = 'Pending Send intent is retained; query or retry its original request explicitly.';
    else if (state === 'failed') message = 'Pi could not complete the last submission.';
    // A chat reports whether its saved working folder is still available.
    const cwd = conversation.cwd;
    const folder = yield* checkCanonicalFolder(cwd).pipe(
      Effect.provideService(FileSystem.FileSystem, reader.fileSystem),
    );
    if (folder !== 'canonical')
      message = [
        message,
        'The saved local working folder is unavailable. Restore its original path, or create another conversation with a new folder.',
      ]
        .filter(Boolean)
        .join(' ');
    const source = yield* getLiveSource(target, captured);
    if (run && source) run.transcript = yield* projectLiveTranscript(reader, source, captured);
    const base = {
      transcriptBoundary: captured.boundary ? String(captured.boundary) : null,
      conversation,
      run,
      state,
      ...(message === undefined ? {} : { message }),
    };
    let history = cache?.history;
    if (!history || history.boundary !== base.transcriptBoundary) {
      const continuations: (string | null)[] = [];
      const page = yield* readHistory(reader, {
        target,
        upperEntryId: base.transcriptBoundary,
        continuations,
      });
      history = { boundary: base.transcriptBoundary, page, continuations };
      if (cache) cache.history = history;
    }
    const page = { ...history.page, entries: [...history.page.entries] };
    // A growing escaped live preview can shrink the page without rereading retained entries.
    while (
      page.entries.length &&
      Buffer.byteLength(JSON.stringify({ ...base, ...page })) > historyPageBytes
    ) {
      page.entries.pop();
      page.olderCursor = page.entries.length
        ? history.continuations[page.entries.length - 1]
        : yield* writeScanCursor(
            { start: true },
            'history',
            getScanCursorScope(identity, target.conversationId),
          );
    }
    return { ...base, ...page };
  });
