import { Context } from 'effect';
import type { ChatFolders, HostConfiguration, RootPredicate } from '../schema.ts';

/** What the file host was configured with: its decoded configuration and its owner's hooks. */
export class HostSettings extends Context.Service<
  HostSettings,
  {
    readonly config: HostConfiguration;
    /** The owner's root policy; without it every root the native picker names may open. */
    readonly allowRoot: RootPredicate | undefined;
    /** The daemon's chat folders, for `turnChatIntoProject`. */
    readonly chats: ChatFolders | undefined;
    /** The journal's clock. */
    readonly now: () => number;
  }
>()('moonbase/workspace/HostSettings') {}
