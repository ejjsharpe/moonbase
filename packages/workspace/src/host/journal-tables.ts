/**
 * The journal tables. `retained_at` starts a row's retention window: when its client acknowledged
 * it (saves, operations), when it was reserved or last settled (requests) or when the host answered
 * that it never saw the ID (a fence, which has no body). A row without it is never discarded.
 * `unsettled` marks a save with no outcome and an uncertain operation.
 */
export const journalSchema = `
CREATE TABLE IF NOT EXISTS journal (kind TEXT NOT NULL, id TEXT NOT NULL, checkout TEXT, installation TEXT, client TEXT, unsettled INTEGER NOT NULL, retained_at INTEGER, body TEXT, PRIMARY KEY(kind, id));
CREATE INDEX IF NOT EXISTS journal_checkout ON journal(kind, checkout, unsettled);
CREATE INDEX IF NOT EXISTS journal_retained ON journal(retained_at) WHERE retained_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS feed (checkout TEXT NOT NULL, sequence INTEGER NOT NULL, operation TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(checkout, sequence));
CREATE INDEX IF NOT EXISTS feed_by_operation ON feed(operation);`;
