import { useContext, useMemo } from 'react';
import type * as Atom from 'effect/reactivity/Atom';
import { RegistryContext, useAtomValue } from '@effect/atom-react';
import {
  describeApplicationFailure,
  type ApplicationAtoms,
  type MoonbaseApplicationShape,
} from '@moonbase/application';
import { getChatAtoms, type ChatAtoms } from '@moonbase/application/chat';
import { runOnPastCaller, useRunNow } from '../hooks/use-run.ts';

/** The application as the shell uses it: its service and atoms over it. */
export type DesktopApplication = {
  readonly service: MoonbaseApplicationShape;
  readonly atoms: ApplicationAtoms;
};

/**
 * The application's lifecycle and the chat it shows, subscribed, with its actions as Effects for
 * the shell to run. Presentation glue: the services decide everything.
 */
export function useDesktopApplication(application: DesktopApplication) {
  const registry = useContext(RegistryContext);
  const lifecycle = useAtomValue(application.atoms.snapshot);
  /** The open chat's services, or null while no chat is open. */
  const chat = useAtomValue(application.atoms.chat);
  const composer = useAtomValue(application.atoms.composer);
  const runNow = useRunNow<boolean>();
  const actions = useMemo(() => {
    const { service } = application;
    return {
      /** The lifecycle now, for a callback. */
      getSnapshot: () => registry.get(application.atoms.snapshot),
      /** One of the open chat's atoms now, for a callback; undefined while no chat is open. */
      readChat: <A>(select: (atoms: ChatAtoms) => Atom.Atom<A>): A | undefined => {
        const services = registry.get(application.atoms.chat);
        return services ? registry.get(select(getChatAtoms(services))) : undefined;
      },
      openChat: runOnPastCaller(service.chat.open),
      selectChatTarget: (id: string) => runOnPastCaller(service.chat.select(id)),
      prepareQuit: service.prepareQuit,
      reportCleanup: service.reportCleanup,
      describe: describeApplicationFailure,
    };
  }, [application, registry]);
  return {
    lifecycle,
    chat,
    composer,
    ...actions,
    /** Closes the chat if its drafts are kept; false when it can't close now. */
    closeChat: () => runNow(application.service.chat.close) ?? false,
  };
}
export type DesktopApplicationView = ReturnType<typeof useDesktopApplication>;
