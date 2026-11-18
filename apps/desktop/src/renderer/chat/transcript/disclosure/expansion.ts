import { Effect } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useAtomValue } from '@effect/atom-react';
import type { TranscriptView } from '@moonbase/application/chat';
import { getTranscriptDisclosureId } from '../../../../ipc/transcript-markdown.ts';
import type { TranscriptShared } from '../transcript-context.ts';

/** Each disclosure's view-memory ID, hashed when long; keyed by `[entryId, id]`. */
const expansionIds = Atom.family((key: string) => {
  const [entryId, id] = JSON.parse(key) as [string, string];
  return Atom.make(
    Effect.suspend(() => {
      const expansion = getTranscriptDisclosureId(entryId, id);
      return typeof expansion === 'string'
        ? Effect.succeed(expansion)
        : Effect.tryPromise(() => expansion);
    }),
  );
});

/**
 * The view-memory expansion ID of disclosure `id` in a row: null while it is being worked out, and
 * `failed` when it can't be, so the disclosure shows expanded.
 */
export function useExpansionId(entryId: string, id: string) {
  const result = useAtomValue(expansionIds(JSON.stringify([entryId, id])));
  return {
    expansion: AsyncResult.isSuccess(result) ? result.value : null,
    failed: AsyncResult.isFailure(result),
  };
}

/** Whether view memory holds a disclosure open; one whose ID can't be worked out shows open. */
export const isRemembered = (
  expansion: string | null,
  failed: boolean,
  expanded: readonly string[],
) => failed || (expansion !== null && expanded.includes(expansion));

/** The view with `expansion` opened or folded; the same view when it already is. */
export const setViewExpansion =
  (expansion: string, open: boolean) =>
  (view: TranscriptView): TranscriptView =>
    view.expanded.includes(expansion) === open
      ? view
      : {
          ...view,
          expanded: open
            ? [...view.expanded, expansion]
            : view.expanded.filter((id) => id !== expansion),
        };

/** Writes one expansion into the transcript's view memory. */
export const rememberExpansion = (
  { act, selection, target }: Pick<TranscriptShared, 'act' | 'selection' | 'target'>,
  expansion: string,
  open: boolean,
) => void act(selection.updateTranscriptView(target, setViewExpansion(expansion, open)));
