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
import { makeLookupAtoms } from './lookup/lookup-atoms.ts';
import { makeTextSearchAtoms } from './text-search/text-search-atoms.ts';
import { toEditorSnapshot } from './editor-snapshot.ts';
import type { EditorServices } from './editor-layer.ts';

/** Read-only atoms over a `SubscriptionRef`. */
const follow = <A>(ref: Parameters<typeof Atom.subscriptionRef<A>>[0]) => {
  const atom = Atom.subscriptionRef(ref);
  return Atom.readable((get) => get(atom));
};

/** Atoms over one editor's state, for views to subscribe to. */
export function makeEditorAtoms(context: Context.Context<EditorServices>) {
  const session = follow(Context.get(context, EditorSession).state);
  const alerts = follow(Context.get(context, EditorAlerts).alerts);
  const views = follow(Context.get(context, EditorViews).state);
  const operations = follow(Context.get(context, EditorOperations).state);
  const outbox = follow(Context.get(context, RecoveryOutbox).state);
  const discovery = follow(Context.get(context, EditorDiscovery).state);
  const buffers = follow(Context.get(context, EditorBuffers).state);
  const mutation = follow(Context.get(context, EditorMutations).state);
  const closePrompt = follow(Context.get(context, EditorPreservation).closePrompt);
  return {
    session,
    views,
    buffers,
    discovery,
    mutation,
    closePrompt,
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
        closePrompt: get(closePrompt),
      }),
    ),
    lookup: makeLookupAtoms(Context.get(context, EditorLookup)),
    textSearch: makeTextSearchAtoms(Context.get(context, EditorTextSearch)),
  };
}
export type EditorAtoms = ReturnType<typeof makeEditorAtoms>;
