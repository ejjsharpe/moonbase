import { useContext, useMemo } from 'react';
import type { Effect } from 'effect';
import type * as Atom from 'effect/reactivity/Atom';
import { RegistryContext, useAtomValue } from '@effect/atom-react';
import {
  describeApplicationFailure,
  type ApplicationAtoms,
  type MoonbaseApplicationShape,
} from '@moonbase/application';
import { getChatAtoms, type ChatAtoms } from '@moonbase/application/chat';

/** The application as the shell uses it: its service, atoms over it, and the root's runners. */
export type DesktopApplication = {
  readonly service: MoonbaseApplicationShape;
  readonly atoms: ApplicationAtoms;
  /** Runs an Effect on the renderer's root runtime, rejecting with its failure. */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** Runs a synchronous Effect on the root runtime, as `beforeunload` and Close need. */
  readonly runSync: <A, E>(effect: Effect.Effect<A, E>) => A;
};
/** The root's runners, for views that run actions of their own. */
export type DesktopRunner = Pick<DesktopApplication, 'run' | 'runSync'>;

/**
 * The application's lifecycle and the chat it shows, subscribed, with its actions as the shell
 * calls them. Presentation glue: the services decide everything.
 */
export function useDesktopApplication(application: DesktopApplication) {
  const registry = useContext(RegistryContext);
  const lifecycle = useAtomValue(application.atoms.snapshot);
  /** The open chat's services, or null while no chat is open. */
  const chat = useAtomValue(application.atoms.chat);
  const composer = useAtomValue(application.atoms.composer);
  const actions = useMemo(() => {
    const { service } = application,
      runner: DesktopRunner = application;
    return {
      /** The lifecycle now, for a callback. */
      getSnapshot: () => registry.get(application.atoms.snapshot),
      /** One of the open chat's atoms now, for a callback; undefined while no chat is open. */
      readChat: <A>(select: (atoms: ChatAtoms) => Atom.Atom<A>): A | undefined => {
        const services = registry.get(application.atoms.chat);
        return services ? registry.get(select(getChatAtoms(services))) : undefined;
      },
      openChat: () => runner.run(service.chat.open),
      /** Closes the chat if its drafts are kept; false when it can't close now. */
      closeChat: () => runner.runSync(service.chat.close),
      selectChatTarget: (id: string) => runner.run(service.chat.select(id)),
      prepareQuit: () => runner.run(service.prepareQuit),
      reportCleanup: (error: unknown) => void runner.run(service.reportCleanup(error)),
      describe: describeApplicationFailure,
    };
  }, [application, registry]);
  return { lifecycle, chat, composer, ...actions };
}
export type DesktopApplicationView = ReturnType<typeof useDesktopApplication>;
