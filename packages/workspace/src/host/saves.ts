import { Cause, Effect } from 'effect';
import type { HostInput, HostSaveResult } from '@moonbase/contracts/workspace-host';
import { UncertainError } from '@moonbase/contracts/errors';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { attempt } from '../attempt.ts';
import type { HostSaveRecord } from '../schema.ts';
import { errorText, hash, path } from '../validation.ts';
import { cancellationPoint } from '../cancellation.ts';
import { Checkouts } from './checkouts.ts';
import { HostJournal } from './host-journal.ts';
import { getOperationFootprint } from './mutations.ts';
import { NativeReferences } from './native-references.ts';

/**
 * Saves a file if it still holds the version the client edited: the text is staged beside it, the
 * disk checked again, and only then swapped in. The request is journalled before the disk is
 * touched, so a lost reply is answered from the journal and the save never runs twice.
 */
export const saveFile = (input: HostInput<'saveFile'>) =>
  Effect.gen(function* () {
    const checkouts = yield* Checkouts;
    const journal = yield* HostJournal;
    const references = yield* NativeReferences;
    yield* attempt(() => {
      path(input.target.path);
      checkouts.approval(input.target.checkout);
    });
    const proposed = { text: input.text, version: hash(input.text) };
    const kept = journal.saveInput(input, proposed.version);
    const id = journal.saveId(input),
      previous = yield* attempt(() => journal.getSave(id));
    if (previous) return yield* attempt(() => journal.replaySave(id, kept, previous));
    yield* journal.assertSettled(
      input.target.checkout,
      [input.target.path],
      input.installationId,
      input.clientId,
      getOperationFootprint(references),
    );
    const directory = yield* checkouts.directory(input.target.checkout),
      disk = yield* Effect.interruptible(directory.read(input.target.path));
    // A save cancelled before it is admitted never runs.
    yield* cancellationPoint;
    if (disk.version !== input.expectedVersion) {
      const result = { kind: 'conflict', disk } as const;
      const occupied = yield* attempt(() => journal.reserveSave(id, { input: kept, result }));
      return occupied ? yield* attempt(() => journal.replaySave(id, kept, occupied)) : result;
    }
    const record: HostSaveRecord = { input: kept };
    const occupied = yield* attempt(() => journal.reserveSave(id, record));
    if (occupied) return yield* attempt(() => journal.replaySave(id, kept, occupied));
    journal.startSave(id);
    return yield* Effect.gen(function* () {
      const temporary = join(dirname(input.target.path), '.moonbase-save-' + randomUUID());
      const stagingIdentity = (yield* directory.io(
        ['stage', input.target.path, temporary],
        input.text,
      )).toString();
      const current = yield* directory.read(input.target.path);
      if (current.version !== input.expectedVersion)
        record.result = { kind: 'conflict', disk: current };
      else {
        yield* directory.io(['replace', input.target.path, temporary, stagingIdentity]);
        record.result = { kind: 'saved', version: proposed.version };
      }
      const result: HostSaveResult = record.result;
      try {
        journal.settleSave(id, record);
      } catch (error) {
        journal.retainSave(id, record);
        if (result.kind === 'saved')
          return {
            ...result,
            persistencePending: true,
            message: 'Saved to disk; durable request publication failed: ' + errorText(error),
          };
      }
      return result;
    }).pipe(
      // The disk may have changed: the request stays journalled, for its status to settle.
      Effect.catchCause((cause) => {
        record.message = errorText(Cause.squash(cause));
        journal.retainSave(id, record);
        return Effect.fail(new UncertainError({ operation: 'Save', target: input.target }));
      }),
      Effect.ensuring(Effect.sync(() => journal.finishSave(id))),
    );
  });
