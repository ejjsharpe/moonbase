import { Effect } from 'effect';
import type { HostSaveResult } from '@moonbase/contracts/workspace-host';
import type { Directory } from '../filesystem.ts';
import type { HostOperationRecord, HostSaveRecord, PlannedItem } from '../schema.ts';
import { folded, isOriginalResult } from '../validation.ts';

// What the disk shows of a save or operation an earlier host process left without an outcome.
// Nothing here repeats a mutation: each reads the disk and says what it finds.

/**
 * An interrupted save's outcome from the disk: its own text there is `saved`, anything else a
 * `conflict` with what is there, over which the client keeps its draft. Fails when the file
 * can't be read, which leaves the save uncertain.
 */
export const readSaveOutcome = (directory: Directory, record: HostSaveRecord) =>
  Effect.map(directory.read(record.input.target.path), (disk): HostSaveResult =>
    disk.version === record.input.version
      ? { kind: 'saved', version: disk.version }
      : { kind: 'conflict', disk },
  );

/**
 * An interrupted operation's items with every item that had no outcome settled from the disk.
 * Each is `completed` when the disk shows its effect (a move's object at its destination,
 * Trash's object gone from its path, a new object at a copy's, import's or creation's
 * destination) and `failed` otherwise, so drafts stay where they are.
 */
export const readOperationItems = (directory: Directory, record: HostOperationRecord) =>
  Effect.gen(function* () {
    const kind = record.input.kind;
    let items = record.result.items;
    const settled = (item: PlannedItem) =>
      items.some(
        (i) => isOriginalResult(kind, i) && i.source === item.source && i.outcome !== 'uncertain',
      );
    const identityAt = (p: string | undefined) =>
      p === undefined
        ? Effect.succeed(null)
        : directory.entry(p).pipe(
            Effect.map((entry): string | null => entry.identity),
            Effect.orElseSucceed(() => null),
          );
    for (const item of record.planned.filter((item) => !settled(item))) {
      const to = yield* identityAt(item.destination);
      const replaced = record.input.replacements?.find(
        (r) => item.destination !== undefined && folded(r.target.path) === folded(item.destination),
      )?.identity;
      let completed = to !== null && to !== replaced;
      if (kind === 'move' || kind === 'trash') {
        const left = (yield* identityAt(item.source)) !== item.identity;
        completed = left && (kind === 'trash' || to === item.identity);
      }
      items = items.filter((i) => !isOriginalResult(kind, i) || i.source !== item.source);
      items.push({
        source: item.source,
        ...(item.destination === undefined ? {} : { destination: item.destination }),
        outcome: completed ? 'completed' : 'failed',
        message: completed
          ? 'Recovered from disk; no mutation repeated.'
          : 'The disk does not show this item done; no mutation repeated. Inspect it.',
      });
    }
    return items;
  });

/** Whether an operation has items with no outcome yet. */
export const hasUnsettledItems = (record: HostOperationRecord) =>
  record.planned.some(
    (item) =>
      !record.result.items.some(
        (i) =>
          isOriginalResult(record.input.kind, i) &&
          i.source === item.source &&
          i.outcome !== 'uncertain',
      ),
  );
