import { Context, Equal } from 'effect';
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
import { makeSessionAtoms } from './session/session-atoms.ts';
import { makeViewsAtoms } from './views/views-atoms.ts';
import { makeBuffersAtoms } from './buffers/buffers-atoms.ts';
import { makeDiscoveryAtoms } from './discovery/discovery-atoms.ts';
import { makeLookupAtoms } from './lookup/lookup-atoms.ts';
import { makeTextSearchAtoms } from './text-search/text-search-atoms.ts';
import { listUnsettled } from './operations/operations.ts';
import { toEditorSnapshot } from './editor-snapshot.ts';
import type { EditorServices } from './editor-layer.ts';
import { followChanges, followRef } from '../follow-ref.ts';

/**
 * Atoms over one editor's state, for views to subscribe to: each concept's, and the pieces of it a
 * view reads, so a change notifies only the views that read what it changed.
 */
export function makeEditorAtoms(context: Context.Context<EditorServices>) {
  const session = makeSessionAtoms(Context.get(context, EditorSession));
  const alerts = followRef(Context.get(context, EditorAlerts).alerts);
  const views = makeViewsAtoms(Context.get(context, EditorViews));
  const operations = followRef(Context.get(context, EditorOperations).state);
  const outbox = followRef(Context.get(context, RecoveryOutbox).state);
  const discovery = makeDiscoveryAtoms(Context.get(context, EditorDiscovery));
  const buffers = makeBuffersAtoms(Context.get(context, EditorBuffers));
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
    alerts,
    /** The last recovery edit failed; edits made since are not kept until a flush succeeds. */
    recoveryFailed: Atom.readable((get) => get(outbox).failure !== undefined),
    /** File operations whose outcome needs resolving. */
    operations: Atom.readable((get) => listUnsettled(get(operations))).pipe(
      Atom.withEquality(Equal.equals),
    ),
    mutation,
    /** Whether a file operation is running, including while it asks. */
    mutating: Atom.readable((get) => get(mutation).mutating),
    replacePrompt,
    closePrompt,
    worktrees,
    /**
     * The whole editor at once, for headless readers and tests. Views read the atoms above: this
     * changes on every edit.
     */
    snapshot: Atom.readable((get) =>
      toEditorSnapshot({
        session: get(session.state),
        alerts: get(alerts),
        views: get(views.state),
        buffers: get(buffers.state),
        discovery: get(discovery.state),
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
