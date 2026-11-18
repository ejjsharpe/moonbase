import { Context } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import { ChatActions } from './actions/actions-service.ts';
import { listActive } from './actions/actions.ts';
import { ChatDrafts } from './drafts/drafts-service.ts';
import { ChatLink } from './link/link-service.ts';
import { ChatList } from './chat-list/chat-list-service.ts';
import { ChatSelection } from './selection/selection-service.ts';
import { ChatSends } from './sends/sends-service.ts';
import { ChatProviderSetup } from './provider-setup/provider-setup-service.ts';
import { ChatFileSearch } from './file-search/file-search-service.ts';
import { makeFileSearchAtoms } from './file-search/file-search-atoms.ts';
import { isSameItems } from './transcript/transcript-row-state.ts';
import type { ChatServices } from './chat-layer.ts';

/** Read-only atoms over a `SubscriptionRef`. */
const follow = <A>(ref: Parameters<typeof Atom.subscriptionRef<A>>[0]) => {
  const atom = Atom.subscriptionRef(ref);
  return Atom.readable((get) => get(atom));
};

/**
 * Atoms over one chat's concepts, for views to subscribe to. Each reads one concept's state and
 * notifies only when what it selects changes, so typing a draft tells only the draft's readers.
 */
function makeChatAtoms(context: Context.Context<ChatServices>) {
  const actions = follow(Context.get(context, ChatActions).state);
  const drafts = follow(Context.get(context, ChatDrafts).state);
  const link = follow(Context.get(context, ChatLink).state);
  const selection = follow(Context.get(context, ChatSelection).state);
  const sends = follow(Context.get(context, ChatSends).state);
  const setup = Context.get(context, ChatProviderSetup);
  const providers = follow(setup.state);
  return {
    /** The host: whether it is remote and verified, its connection and configuration. */
    link,
    /** Whether the host is verified and the chat can act. */
    ready: Atom.readable((get) => get(link).ready),
    /** The chats listed, and the cursor Show older continues from. */
    list: follow(Context.get(context, ChatList).state),
    /** The named actions running (`send`, `stop`, `settle`…); none while the chat closes. */
    active: Atom.readable((get): readonly string[] => listActive(get(actions))).pipe(
      Atom.withEquality(isSameItems),
    ),
    /** The chat's last error, shown until the next action. */
    error: Atom.readable((get) => get(actions).error),
    /** The chat's status notice. */
    notice: Atom.readable((get) => get(actions).notice),
    /** The drafts' whole state, which changes with each keystroke: for the composer alone. */
    drafts,
    /** The open chat's target, or null for a new chat. */
    selected: Atom.readable((get) => get(drafts).saved.selected),
    /** Commands whose outcome the host never confirmed. */
    pending: Atom.readable((get) => get(drafts).saved.pending),
    /** Chats you have looked at and the activity time you saw; absent before the first listing. */
    seen: Atom.readable((get) => get(drafts).saved.seen),
    /** Why drafts can't be kept; it blocks sends and Quit. */
    storageError: Atom.readable((get) => get(drafts).storageError),
    /** Request IDs of pending commands this session is still sending. */
    dispatching: Atom.readable((get): readonly string[] =>
      Object.keys(get(sends).dispatching),
    ).pipe(Atom.withEquality(isSameItems)),
    /** The open chat's latest snapshot. */
    snapshot: Atom.readable((get) => get(selection).snapshot),
    /** The open chat's working folder, as its snapshot names it (null before one arrives). */
    snapshotFolder: Atom.readable((get) => get(selection).snapshot?.conversation.cwd ?? null),
    /** The open chat's transcript. */
    transcript: Atom.readable((get) => get(selection).transcript),
    /** The transcript's Find: its query, matches and status. */
    find: Atom.readable((get) => get(selection).transcript.find),
    /** Whether the transcript's Find bar is open. */
    findOpen: Atom.readable((get) => get(selection).transcript.find.open),
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

const made = new WeakMap<Context.Context<ChatServices>, ChatAtoms>();
/** The chat's atoms, made once per chat so all its views share them. */
export function getChatAtoms(context: Context.Context<ChatServices>): ChatAtoms {
  let atoms = made.get(context);
  if (!atoms) made.set(context, (atoms = makeChatAtoms(context)));
  return atoms;
}
