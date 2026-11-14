import { isPathAtOrInside } from '@moonbase/contracts/paths';
import { Cause, Effect, Exit } from 'effect';
import type { HostInput, HostOperationResult } from '@moonbase/contracts/workspace-host';
import { WorkspaceConflictError } from '@moonbase/contracts/workspace-host-errors';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { attempt } from '../attempt.ts';
import type { Directory } from '../filesystem.ts';
import type { HostOperationRecord } from '../schema.ts';
import { ensure, errorText, folded, path, same } from '../validation.ts';
import { cancellationPoint, isCancelled } from './cancellation.ts';
import { Checkouts } from './checkouts.ts';
import { HostJournal } from './host-journal.ts';
import type { NativeImport } from './native-import.ts';
import { NativeReferences, type References } from './native-references.ts';

type OperationSource = {
  path: string;
  identity: string;
  directory: boolean;
  native?: NativeImport;
};
const containsSelectedSource = (
  entry: { path: string; identity: string; directory: boolean },
  source: { path: string; identity: string; native?: NativeImport },
) =>
  entry.identity === source.identity ||
  (entry.directory &&
    (source.native
      ? source.native.parents.split(',').includes(entry.identity)
      : isPathAtOrInside(source.path, entry.path)));

/** The paths an operation touches: its sources, and where each lands. */
export const getOperationFootprint =
  (references: Pick<References, 'getSourceName'>) => (input: HostInput<'mutate'>) => {
    const sources = input.sources.map((s) => s.target.path);
    if (input.destination === undefined) return sources;
    const names = sources.length
      ? sources.map((p) => basename(p))
      : (input.nativeReferences ?? []).map((token) => references.getSourceName(token));
    return [
      ...sources,
      ...(names.length > 1
        ? names.map((name) => (name ? join(input.destination!, name) : input.destination!))
        : [input.destination]),
    ];
  };

/**
 * Runs a file operation: its selection is checked, durably planned and only then carried out item
 * by item, each journalled as it lands. An item stopped part way, or a failure that leaves its
 * object's place unknown, is `uncertain`, and the rest are not tried; nothing is ever repeated.
 * A cancelled operation records its untried items as failed.
 */
export const mutate = (input: HostInput<'mutate'>) =>
  Effect.gen(function* () {
    const checkouts = yield* Checkouts;
    const journal = yield* HostJournal;
    const references = yield* NativeReferences;
    yield* attempt(() => {
      checkouts.approval(input.checkout);
      ensure(
        input.text === undefined || input.kind === 'create-file',
        'Text belongs only to file creation.',
      );
    });
    const id = journal.operationId(input),
      previous = yield* attempt(() => journal.getOperation(id));
    if (previous) return yield* attempt(() => journal.replayOperation(id, input, previous));
    yield* journal.assertSettled(
      input.checkout,
      getOperationFootprint(references)(input),
      input.installationId,
      input.clientId,
      getOperationFootprint(references),
    );
    yield* cancellationPoint;
    const directory = yield* checkouts.directory(input.checkout);
    const { items, tokens, replacements } = yield* Effect.interruptible(
      prepareMutation(input, directory, references),
    );
    const create = input.kind.startsWith('create-');
    const importing = input.kind === 'import';
    const staging = items.map((item) => item.staging);
    const record: HostOperationRecord = {
      input,
      result: {
        id: input.id,
        clientId: input.clientId,
        checkout: input.checkout,
        kind: input.kind,
        outcome: 'uncertain',
        items: [],
        message:
          'Admitted operation. Interrupted items must be inspected, never repeated automatically.',
      },
      // The complete immutable selection is durable before the first native mutation.
      planned: items.map(({ source, destination }) => ({
        source: source.path,
        identity: source.identity,
        destination,
      })),
    };
    // The last point a cancelled operation stops: nothing may yield from inspecting the native
    // references to claiming them, or two operations could both claim one.
    yield* cancellationPoint;
    const claims = yield* attempt(() =>
      references.inspectReferences(tokens, input.checkout, input.clientId),
    );
    const occupied = yield* attempt(() => journal.reserveOperation(id, record));
    if (occupied) return yield* attempt(() => journal.replayOperation(id, input, occupied));
    yield* references.claimReferences(claims);
    /** Records a durable write that failed and returns the outcome held in memory. */
    const retained = (error: unknown) => {
      record.result.message =
        'Filesystem outcome retained in memory; durable publication failed: ' + errorText(error);
      journal.retainOperation(id, record);
      return record.result;
    };
    for (const { source, destination, staging: temporary } of items) {
      if (yield* isCancelled) {
        record.result.items.push({
          source: source.path,
          destination,
          outcome: 'failed',
          message: 'Cancelled before this item started.',
        });
        continue;
      }
      const replacement = replacements.find(
        (r) =>
          destination !== undefined &&
          dirname(r.target.path) === dirname(destination) &&
          folded(r.target.path) === folded(destination),
      );
      const done = yield* Effect.exit(
        Effect.gen(function* () {
          if (replacement) {
            const trashLocation = (yield* Effect.interruptible(
              directory.io(['trash', replacement.target.path, '-', replacement.identity]),
            )).toString();
            record.result.items.push({
              source: replacement.target.path,
              outcome: 'completed',
              message: 'Explicit replacement moved to macOS Trash: ' + trashLocation,
            });
            yield* attempt(() => journal.writeOperation(id, record));
          }
          if (create) {
            const parent = yield* directory.destination(destination!);
            yield* Effect.interruptible(
              directory.io(
                [
                  'create',
                  dirname(destination!) === '.' ? '.' : dirname(destination!),
                  basename(destination!),
                  source.directory ? 'folder' : 'file',
                  parent,
                ],
                input.text,
              ),
            );
          } else if (input.kind === 'move') {
            yield* Effect.interruptible(
              directory.io(['move', source.path, destination!, source.identity]),
            );
            const moved = yield* directory.entry(destination!);
            yield* attempt(() =>
              ensure(
                moved.identity === source.identity,
                'Move destination identity changed after native success.',
              ),
            );
          } else if (input.kind === 'trash') {
            const trashPath = (yield* Effect.interruptible(
              directory.io(['trash', source.path, '-', source.identity]),
            )).toString();
            record.result.items.push({
              source: source.path,
              outcome: 'completed',
              message: trashPath ? 'macOS Trash: ' + trashPath : 'Moved to macOS Trash.',
            });
            yield* attempt(() => journal.writeOperation(id, record));
            return 'journalled' as const;
          } else {
            const parent = yield* directory.destination(destination!);
            yield* Effect.interruptible(
              directory.io(
                [
                  importing ? 'import' : 'copy',
                  source.path,
                  destination!,
                  source.identity,
                  temporary,
                  parent,
                  ...(source.native
                    ? [source.native.path, source.native.parents, input.checkout.root]
                    : []),
                ],
                undefined,
                source.native ? [source.native.fd] : [],
              ),
            );
          }
          record.result.items.push({ source: source.path, destination, outcome: 'completed' });
          return 'done' as const;
        }),
      );
      if (Exit.isSuccess(done) && done.value === 'journalled') continue;
      if (Exit.isFailure(done)) {
        // An item stopped part way is uncertain, like one the helper reports as uncertain.
        const error = Cause.hasInterruptsOnly(done.cause) ? undefined : Cause.squash(done.cause);
        let outcome: 'failed' | 'uncertain' = 'uncertain';
        // A preflight error is known only while the original object still occupies its exact path.
        if (
          error !== undefined &&
          !(error as { uncertain?: boolean }).uncertain &&
          !create &&
          !['copy', 'import'].includes(input.kind) &&
          !replacement
        ) {
          const left = yield* Effect.exit(directory.entry(source.path));
          if (Exit.isSuccess(left) && left.value.identity === source.identity) outcome = 'failed';
        }
        record.result.items.push({
          source: source.path,
          destination,
          outcome,
          message: error === undefined ? 'Cancelled while this item ran.' : errorText(error),
        });
      }
      const written = yield* Effect.exit(attempt(() => journal.writeOperation(id, record)));
      if (Exit.isFailure(written)) return retained(Cause.squash(written.cause));
      if (record.result.items.some((item) => item.outcome === 'uncertain')) break;
    }
    if (
      record.result.items.some((i) => i.outcome === 'uncertain') ||
      record.result.items.length < items.length
    )
      record.result.outcome = 'uncertain';
    else if (record.result.items.every((i) => i.outcome === 'completed'))
      record.result.outcome = 'completed';
    else record.result.outcome = 'failed';
    if (record.result.outcome === 'uncertain')
      record.result.message =
        'Inspect original, destination, Finder Trash and staging: ' +
        staging.filter(Boolean).join(', ') +
        '. Drafts and journal retained; no automatic retry.';
    else delete record.result.message;
    const finalized = yield* Effect.exit(attempt(() => journal.finalizeOperation(id, record)));
    if (Exit.isFailure(finalized)) return retained(Cause.squash(finalized.cause));
    return record.result as HostOperationResult;
  });

/** Checks an operation's selection against the disk and plans where each item lands. */
const prepareMutation = (
  input: HostInput<'mutate'>,
  directory: Directory,
  references: References,
) =>
  Effect.gen(function* () {
    const create = input.kind.startsWith('create-');
    const importing = input.kind === 'import';
    const tokens = input.nativeReferences ?? [];
    yield* attempt(() => {
      ensure(new Set(tokens).size === tokens.length, 'Invalid native references.');
      ensure(
        importing
          ? input.sources.length === 0 && tokens.length > 0
          : tokens.length === 0 && (create ? input.sources.length === 0 : input.sources.length > 0),
        'Invalid operation source selection.',
      );
    });
    const sources: OperationSource[] = [];
    for (const entry of input.sources) {
      yield* attempt(() => {
        ensure(
          same(entry.target.checkout, input.checkout),
          'Source target belongs to another checkout.',
        );
        path(entry.target.path);
      });
      const actual = yield* directory.entry(entry.target.path);
      if (!same(actual, { identity: entry.identity, directory: entry.directory }))
        return yield* new WorkspaceConflictError({
          reason: 'Source changed. Capture a fresh selection before continuing.',
        });
      yield* attempt(() =>
        ensure(
          !sources.some(
            (s) =>
              isPathAtOrInside(entry.target.path, s.path) ||
              isPathAtOrInside(s.path, entry.target.path),
          ),
          'Overlapping sources are not one selection.',
        ),
      );
      sources.push({ path: entry.target.path, ...actual });
    }
    for (const { ref } of yield* attempt(() =>
      references.inspectReferences(tokens, input.checkout, input.clientId),
    )) {
      sources.push({
        path: ref.source.source,
        identity: ref.source.identity,
        directory: ref.source.directory,
        native: ref.source,
      });
    }
    if (create)
      sources.push({ path: '', identity: '', directory: input.kind === 'create-directory' });
    if (input.kind !== 'trash') yield* attempt(() => path(input.destination, sources.length > 1));
    const destinations = sources.map((source) => {
      if (input.kind === 'trash') return undefined;
      if (sources.length === 1) return input.destination!;
      return join(input.destination!, basename(source.path));
    });
    if (sources.length > 1 && input.kind !== 'trash') {
      const batch = yield* directory.entry(input.destination!);
      yield* attempt(() =>
        ensure(batch.directory, 'Batch destination must be an existing folder.'),
      );
    }
    yield* attempt(() =>
      ensure(
        new Set(destinations.filter(Boolean).map((p) => folded(p!))).size ===
          destinations.filter(Boolean).length,
        'Selection has colliding destination names.',
      ),
    );
    const replacements = input.replacements ?? [];
    yield* attempt(() =>
      ensure(replacements.length <= sources.length, 'Invalid replacement selection.'),
    );
    const replacementDestinations = new Set<string>();
    for (const replacement of replacements) {
      yield* attempt(() => {
        ensure(
          same(replacement.target.checkout, input.checkout) &&
            destinations.some(
              (destination) =>
                destination !== undefined &&
                dirname(destination) === dirname(replacement.target.path) &&
                folded(destination) === folded(replacement.target.path),
            ),
          'Replacement must name the exact captured destination.',
        );
        const destination = folded(replacement.target.path);
        ensure(
          !replacementDestinations.has(destination),
          'A destination cannot have multiple replacements.',
        );
        replacementDestinations.add(destination);
      });
      const actual = yield* directory.entry(replacement.target.path);
      if (!same(actual, { identity: replacement.identity, directory: replacement.directory }))
        return yield* new WorkspaceConflictError({
          reason: 'Replacement changed. Confirm a freshly captured destination.',
        });
      yield* attempt(() =>
        ensure(
          !sources.some((source) =>
            containsSelectedSource({ path: replacement.target.path, ...actual }, source),
          ),
          'A replacement cannot contain or replace a selected source.',
        ),
      );
    }
    const items = sources.map((source, i) => {
      const destination = destinations[i];
      const staging =
        destination && ['copy', 'import'].includes(input.kind)
          ? join(dirname(destination), '.moonbase-copy-' + randomUUID())
          : '';
      return { source, destination, staging };
    });
    for (const { source, destination } of items) {
      if (!destination) continue;
      yield* attempt(() => path(destination));
      yield* directory.destination(destination);
      for (const selected of sources.filter((s) => s.native)) {
        const native = selected.native!;
        yield* attempt(() => {
          native.validate();
          ensure(
            !native.containsDirectory(resolve(input.checkout.root, dirname(destination))),
            'Choose a native import destination outside its source directory.',
          );
        });
        const actual = yield* directory.entry(destination).pipe(
          Effect.map((entry): { identity: string; directory: boolean } | undefined => entry),
          Effect.catch((error) =>
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        );
        yield* attempt(() =>
          ensure(
            !actual || !containsSelectedSource({ path: destination, ...actual }, selected),
            'A native import cannot replace itself or an ancestor of its source.',
          ),
        );
      }
      yield* attempt(() => {
        if (!source.native && !create)
          ensure(
            !isPathAtOrInside(folded(destination), folded(source.path)) ||
              (input.kind === 'move' &&
                destination !== source.path &&
                folded(destination) === folded(source.path)),
            'Choose a destination outside the source.',
          );
        ensure(
          !sources.some(
            (s) => s.path !== source.path && isPathAtOrInside(folded(destination), folded(s.path)),
          ),
          'Destination overlaps another selected source.',
        );
      });
    }
    return { items, tokens, replacements };
  });
