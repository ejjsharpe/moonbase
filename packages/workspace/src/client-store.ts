import { randomUUID } from 'node:crypto';
import {
  type CommandInput,
  type EditorRecovery,
  type RecoveryPublication,
} from '@moonbase/contracts/workspace';
import { Store } from './store.ts';
import { canonical, errorText, fail, hash } from './validation.ts';
import { clientDecoders, parseRecovery, savedRevision } from './client-schema.ts';
import { invalidStored } from './store.ts';

// shortcut: settled save and operation records and publication receipts still grow on disk; compact
// them only with proven replay and recovery compatibility. The file host's journal does compact.
/** Saves with something left to do; a partial index keeps settled history out of every read. */
export const pendingSaves = "json_extract(body, '$.state') IN ('sent', 'restored', 'settled')";
/** Operations with something left to do (see `OperationRecord.open`), indexed the same way. */
export const openOperations = "json_extract(body, '$.open') = 1";

type PublicationRecord = { digest: string; receipt: RecoveryPublication };
export type StoredRecovery = {
  client: string;
  revision: number;
  body: string;
  state: EditorRecovery;
};

/** One client's recovery, saves and operations, and publication receipts; the file name is stable. */
export class ClientStore extends Store {
  /** This store's identity to a file host, minted the first time and kept in the store. */
  readonly installationId: string;
  constructor(directory: string, installationId?: string) {
    super(directory, {
      file: 'moonbase-workspace-v1.sqlite',
      applicationId: 1296193363,
      schema: `CREATE TABLE IF NOT EXISTS recovery (client TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
        DROP INDEX IF EXISTS pending_saves_v3;
        CREATE INDEX IF NOT EXISTS pending_saves ON records(bucket) WHERE bucket='saves' AND ${pendingSaves};
        CREATE INDEX IF NOT EXISTS open_operations ON records(bucket) WHERE bucket='operations' AND ${openOperations};`,
      decoders: clientDecoders,
    });
    try {
      const claimed = installationId ?? this.get<string>('meta', 'installation') ?? randomUUID();
      this.claim('installation', claimed, 'Workspace store belongs to a different client.');
      this.installationId = claimed;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  readRecovery(client: string): { revision: number; state: EditorRecovery } | null {
    const row = this.db.prepare('SELECT revision, body FROM recovery WHERE client=?').get(client);
    if (!row) return null;
    const revision = savedRevision(row.revision);
    return { revision, state: parseRecovery(row.body, client) };
  }
  /**
   * Every client's stored recovery, parsed once, split into those that read and those that don't,
   * so one unreadable row is skipped (and reported where it matters) and never stalls the others.
   */
  readRecoveries() {
    const readable: StoredRecovery[] = [];
    const unreadable: { client: string; error: string }[] = [];
    for (const row of this.db.prepare('SELECT client, revision, body FROM recovery').all()) {
      const client = row.client as string;
      try {
        readable.push({
          client,
          revision: savedRevision(row.revision),
          body: row.body as string,
          state: parseRecovery(row.body, client),
        });
      } catch (error) {
        unreadable.push({ client, error: errorText(error) });
      }
    }
    return { readable, unreadable };
  }
  publication(client: string): number {
    return this.get<number>('publications', client) ?? 0;
  }
  recoveryPublication(clientId: string, requestId: string) {
    const record = this.get<PublicationRecord>(
      'recovery-publications',
      hash(canonical([clientId, requestId])),
    );
    if (record) {
      const receipt = record.receipt;
      const row = this.db.prepare('SELECT revision FROM recovery WHERE client=?').get(clientId);
      const currentRevision = row ? savedRevision(row.revision) : -1;
      if (
        receipt.clientId !== clientId ||
        receipt.requestId !== requestId ||
        !Number.isSafeInteger(receipt.previousRevision) ||
        !Number.isSafeInteger(receipt.revision) ||
        receipt.revision !== receipt.previousRevision + 1 ||
        !Number.isSafeInteger(currentRevision) ||
        receipt.revision > currentRevision
      )
        throw invalidStored();
    }
    return record;
  }
  replayPublication(
    input: CommandInput<'persistRecovery'>,
    digest: string,
  ): RecoveryPublication | null {
    const previous = this.recoveryPublication(input.clientId, input.requestId);
    if (previous && previous.digest !== digest)
      fail(
        'InvalidInput',
        'Recovery request ID already belongs to a different immutable publication.',
      );
    if (previous && previous.receipt.previousRevision !== input.expectedRevision)
      throw invalidStored();
    return previous?.receipt ?? null;
  }
  /**
   * Writes a state the caller read and checked in the same transaction, advancing the revision
   * without impersonating a client publication.
   */
  writeInternalRecovery(client: string, revision: number, state: EditorRecovery) {
    this.db
      .prepare(
        'INSERT INTO recovery VALUES(?,?,?) ON CONFLICT(client) DO UPDATE SET revision=excluded.revision, body=excluded.body',
      )
      .run(client, revision + 1, JSON.stringify(state));
  }
  persist(input: CommandInput<'persistRecovery'>, digest: string): RecoveryPublication {
    return this.transaction(() => {
      const previous = this.replayPublication(input, digest);
      if (previous) return previous;
      const { clientId: client, requestId, expectedRevision: expected, state } = input;
      const revision = this.readRecovery(client)?.revision ?? 0;
      if (revision !== expected)
        fail('Conflict', 'Recovery changed in another window. Reload before publishing.');
      const receipt = {
        clientId: client,
        requestId,
        previousRevision: revision,
        revision: revision + 1,
      };
      this.db
        .prepare(
          'INSERT INTO recovery VALUES(?,?,?) ON CONFLICT(client) DO UPDATE SET revision=excluded.revision, body=excluded.body',
        )
        .run(client, revision + 1, JSON.stringify(state));
      this.put('publications', client, revision + 1);
      this.put('recovery-publications', hash(canonical([client, requestId])), { digest, receipt });
      return receipt;
    });
  }
}
