import { Context } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import { ChatActions } from './actions/actions-service.ts';
import { ChatDrafts } from './drafts/drafts-service.ts';
import { ChatLink } from './link/link-service.ts';
import { ChatList } from './chat-list/chat-list-service.ts';
import { ChatSelection } from './selection/selection-service.ts';
import { ChatSends } from './sends/sends-service.ts';
import { ChatProviderSetup } from './provider-setup/provider-setup-service.ts';
import { ChatFileSearch } from './file-search/file-search-service.ts';
import { makeFileSearchAtoms } from './file-search/file-search-atoms.ts';
import type { ChatServices } from './chat-layer.ts';
import { toChatState } from './chat-state.ts';

/** Read-only atoms over a `SubscriptionRef`. */
const follow = <A>(ref: Parameters<typeof Atom.subscriptionRef<A>>[0]) => {
  const atom = Atom.subscriptionRef(ref);
  return Atom.readable((get) => get(atom));
};

/** Atoms over one chat's state, for views to subscribe to. */
export function makeChatAtoms(context: Context.Context<ChatServices>) {
  const actions = follow(Context.get(context, ChatActions).state);
  const drafts = follow(Context.get(context, ChatDrafts).state);
  const link = follow(Context.get(context, ChatLink).state);
  const list = follow(Context.get(context, ChatList).state);
  const selection = follow(Context.get(context, ChatSelection).state);
  const sends = follow(Context.get(context, ChatSends).state);
  const setup = Context.get(context, ChatProviderSetup);
  const providers = follow(setup.state);
  return {
    state: Atom.readable((get) =>
      toChatState({
        actions: get(actions),
        drafts: get(drafts),
        link: get(link),
        list: get(list),
        selection: get(selection),
        sends: get(sends),
      }),
    ),
    /** The open chat's latest snapshot. */
    snapshot: Atom.readable((get) => get(selection).snapshot),
    /** The open chat's transcript. */
    transcript: Atom.readable((get) => get(selection).transcript),
    /** Whether the host is verified and the chat can act. */
    ready: Atom.readable((get) => get(link).ready),
    /** Provider setup as a view shows it, or null when the host serves none. */
    providers: Atom.readable((get) => {
      if (!setup.available) return null;
      const { status, busy, error } = get(providers);
      return { status, busy, error };
    }),
    fileSearch: makeFileSearchAtoms(Context.get(context, ChatFileSearch)),
  };
}
export type ChatAtoms = ReturnType<typeof makeChatAtoms>;
