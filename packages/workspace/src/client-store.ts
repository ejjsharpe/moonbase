import { type RecoveryPublication, type CommandInput } from '@moonbase/contracts/workspace';
import { Store } from './store.ts';
import { canonical, fail, hash } from './validation.ts';
import { clientDecoders, parseRecovery, savedRevision } from './client-schema.ts';
import { invalidStored } from './store.ts';

// shortcut: settled save and operation records and publication receipts still grow on disk; compact
// them only with proven replay and recovery compatibility. The file host's journal does compact.
export const pendingSaves =
  "(json_extract(body, '$.published') IS NOT 1 OR json_extract(body, '$.restorePending') = 1 OR (json_extract(body, '$.result') IS NULL AND json_extract(body, '$.notStarted') IS NOT 1))";

type PublicationRecord = { digest: string; receipt: RecoveryPublication };

/** One client's recovery, saves and operations, and publication receipts; the file name is stable. */
export class ClientStore extends Store {
  constructor(directory: string, installationId: string) {
    super(directory, {
      file: 'moonbase-workspace-v1.sqlite',
      applicationId: 1296193363,
      schema: `CREATE TABLE IF NOT EXISTS recovery (client TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS pending_saves_v3 ON records(bucket) WHERE bucket='saves' AND ${pendingSaves};`,
      decoders: clientDecoders,
    });
    try {
      this.claim('installation', installationId, 'Workspace store belongs to a different client.');
    } catch (error) {
      this.close();
      throw error;
    }
  }
  readRecovery(client: string): { revision: number; state: unknown } | null {
    const row = this.db.prepare('SELECT revision, body FROM recovery WHERE client=?').get(client);
    if (!row) return null;
    const revision = savedRevision(row.revision);
    return { revision, state: parseRecovery(row.body, client) };
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
  /** Caller owns the transaction; module facts advance CAS without impersonating a client publication. */
  writeInternalRecovery(client: string, revision: number, state: unknown) {
    this.readRecovery(client);
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
