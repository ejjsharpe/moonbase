import { Context, type Effect } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import type { ChatTarget } from '@moonbase/contracts/chat';

/** Privileged shutdown control; it grants no renderer capability. */
export class LocalPiControl extends Context.Service<
  LocalPiControl,
  {
    setAdmissionsOpen(open: boolean): void;
    hasActiveWork(): Effect.Effect<boolean, ApplicationError>;
    /** Clears `ownFolder` once a chat's own folder has become a project where it is. */
    markFolderAsProject(target: ChatTarget): Effect.Effect<void, ApplicationError>;
  }
>()('moonbase/LocalPiControl') {}
