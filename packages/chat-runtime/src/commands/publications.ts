import {
  LiveDoc,
  NestedCallDoc,
  type CommitPublication,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { Metadata, Store } from '../documents.ts';

/** What one commit means for a watched conversation's projection and its caches. */
export type PublicationEffect = {
  /** The watched view must be read again. */
  relevant: boolean;
  /** An in-flight capture is stale, not only outpaced by streamed progress. */
  invalidatesCapture: boolean;
  /** The cached transcript boundary and history page are stale. */
  resetsHistory: boolean;
  /** The cached run status is stale. */
  resetsStatus: boolean;
  /** Whether the live document is retired; undefined when this commit did not touch it. */
  liveRetired: boolean | undefined;
};
const progressPaths = ['output', 'details', 'diagnostics', 'droppedBytes', 'droppedLines'];
/** A live document change that only streams a response's text or tools' progress. */
function isProgressOnly(change: CommitPublication['changes'][number]) {
  return (
    change.type === 'document' &&
    change.record.kind === LiveDoc.definition.kind &&
    change.value !== null &&
    change.ops.length !== 0 &&
    change.ops.every((op) => {
      if (op[0] === 'r') return false;
      const path = op[1];
      return (
        (path[0] === 'generation' && path[1] === 'message') ||
        ((path[0] === 'tools' || path[0] === 'nestedTools') &&
          typeof path[1] === 'number' &&
          progressPaths.includes(String(path[2])))
      );
    })
  );
}
/**
 * The chats whose listing a commit may change: a conversation, task or metadata change, or a live
 * document change other than streamed progress, which can start or end a run.
 */
export function listedChanges(publication: CommitPublication): string[] {
  const ids = new Set<string>();
  for (const change of publication.changes) {
    if (change.type === 'document' || change.type === 'document.copy') {
      if (
        change.conversationId !== undefined &&
        (change.record.kind === Metadata.definition.kind ||
          (change.record.kind === LiveDoc.definition.kind && !isProgressOnly(change)))
      )
        ids.add(String(change.conversationId));
    } else if (change.type === 'conversation') ids.add(String(change.value.id));
    else if (change.type === 'task') ids.add(String(change.value.conversationId));
  }
  return [...ids];
}
export function classifyPublication(
  publication: CommitPublication,
  conversationId: ConversationId,
): PublicationEffect {
  const effect: PublicationEffect = {
    relevant: false,
    invalidatesCapture: false,
    resetsHistory: false,
    resetsStatus: false,
    liveRetired: undefined,
  };
  let liveRetired = false,
    livePresent = false;
  for (const change of publication.changes) {
    if (change.type === 'document' || change.type === 'document.copy') {
      const kind = change.record.kind;
      if (change.conversationId === conversationId) {
        if (
          kind !== LiveDoc.definition.kind &&
          kind !== Metadata.definition.kind &&
          kind !== NestedCallDoc.definition.kind
        )
          continue;
        effect.relevant = true;
        // Progress can outpace projection without invalidating its captured source/control.
        effect.invalidatesCapture ||= !isProgressOnly(change);
        if (kind === LiveDoc.definition.kind) {
          if (change.type === 'document' && change.value === null) liveRetired = true;
          else livePresent = true;
        }
        if (
          change.type === 'document.copy' ||
          (change.type === 'document' && (!change.ops.length || change.value === null))
        ) {
          effect.resetsHistory = true;
          effect.resetsStatus = true;
        }
      } else if (kind === Store.definition.kind && change.record.scope.kind === 'session') {
        effect.relevant = true;
        effect.invalidatesCapture = true;
        effect.resetsHistory = true;
        effect.resetsStatus = true;
      }
    } else {
      const owner = change.type === 'conversation' ? change.value.id : change.value.conversationId;
      if (owner !== conversationId) continue;
      effect.relevant = true;
      effect.invalidatesCapture = true;
      if (change.type === 'entry' || change.type === 'conversation') effect.resetsHistory = true;
      if (change.type === 'task' || change.type === 'conversation') effect.resetsStatus = true;
    }
  }
  if (liveRetired || livePresent) effect.liveRetired = liveRetired && !livePresent;
  return effect;
}
