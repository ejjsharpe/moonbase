import { Context } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import { EditorSession } from './session/session-service.ts';
import { EditorAlerts } from './alerts/alerts-service.ts';
import { EditorViews } from './views/views-service.ts';
import { EditorOperations } from './operations/operations-service.ts';
import { RecoveryOutbox } from './recovery/recovery-outbox-service.ts';
import { EditorDiscovery } from './discovery/discovery-service.ts';
import { EditorBuffers } from './buffers/buffers-service.ts';
import { EditorMutations } from './mutation/mutation-service.ts';
import { EditorPreservation } from './preservation/preservation-service.ts';
import { EditorLookup } from './lookup/lookup-service.ts';
import { EditorTextSearch } from './text-search/text-search-service.ts';
import { EditorWorktrees } from './worktrees/worktrees-service.ts';
import { makeLookupAtoms } from './lookup/lookup-atoms.ts';
import { makeTextSearchAtoms } from './text-search/text-search-atoms.ts';
import { toEditorSnapshot } from './editor-snapshot.ts';
import type { EditorServices } from './editor-layer.ts';
import { followChanges, followRef } from '../follow-ref.ts';

/** Atoms over one editor's state, for views to subscribe to. */
export function makeEditorAtoms(context: Context.Context<EditorServices>) {
  const session = followRef(Context.get(context, EditorSession).state);
  const alerts = followRef(Context.get(context, EditorAlerts).alerts);
  const views = followRef(Context.get(context, EditorViews).state);
  const operations = followRef(Context.get(context, EditorOperations).state);
  const outbox = followRef(Context.get(context, RecoveryOutbox).state);
  const discovery = followRef(Context.get(context, EditorDiscovery).state);
  const buffers = followRef(Context.get(context, EditorBuffers).state);
  const mutations = Context.get(context, EditorMutations);
  const mutation = followRef(mutations.state);
  const replacePrompt = followChanges(mutations.replacePrompt.changes, null);
  const closePrompt = followChanges(
    Context.get(context, EditorPreservation).closePrompt.changes,
    null,
  );
  const worktrees = followRef(Context.get(context, EditorWorktrees).state);
  return {
    session,
    views,
    buffers,
    discovery,
    mutation,
    worktrees,
    snapshot: Atom.readable((get) =>
      toEditorSnapshot({
        session: get(session),
        alerts: get(alerts),
        views: get(views),
        buffers: get(buffers),
        discovery: get(discovery),
        operations: get(operations),
        outbox: get(outbox),
        mutation: get(mutation),
        replacePrompt: get(replacePrompt),
        closePrompt: get(closePrompt),
      }),
    ),
    lookup: makeLookupAtoms(Context.get(context, EditorLookup)),
    textSearch: makeTextSearchAtoms(Context.get(context, EditorTextSearch)),
  };
}
export type EditorAtoms = ReturnType<typeof makeEditorAtoms>;
