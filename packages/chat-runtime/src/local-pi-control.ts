import { Context, type Effect } from 'effect';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import type { ChatTarget } from '@moonbase/contracts/chat';

/** Privileged shutdown control; it grants no renderer capability. */
export class LocalPiControl extends Context.Service<
  LocalPiControl,
  {
    /** Closing refuses new mutations as `quitting`; opening admits them again. */
    setAdmissionsOpen(open: boolean): Effect.Effect<void>;
    hasActiveWork(): Effect.Effect<boolean, ChatError>;
    /** Clears `ownFolder` once a chat's own folder has become a project where it is. */
    markFolderAsProject(target: ChatTarget): Effect.Effect<void, ChatError>;
  }
>()('moonbase/LocalPiControl') {}
