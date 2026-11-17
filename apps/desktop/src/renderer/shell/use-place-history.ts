import { useEffect, useSyncExternalStore } from 'react';
import type { ChatController } from '@moonbase/application/chat';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { useAtomValue } from '@effect/atom-react';
import { Effect } from 'effect';
import { findStep, type Place } from '@moonbase/application';
import type { DesktopApplication } from './desktop-application.ts';

const noSubscription = () => () => {};

/**
 * Back and forward through the places the window has shown: a chat in Agents, or a project and
 * its file. Tells the application's history the place showing now, and steps to the nearest place
 * back or forward that can still show, which `show` brings into view.
 */
export function usePlaceHistory({
  application,
  chat,
  project,
  activePath,
  openCheckouts,
  show,
  report,
}: {
  application: DesktopApplication;
  chat: ChatController | null;
  /** The project showing, absent while Agents shows. */
  project: CheckoutTarget | undefined;
  activePath: string | null | undefined;
  openCheckouts: readonly CheckoutTarget[];
  show(place: Place): Promise<void>;
  report(error: unknown): void;
}) {
  const chatSelected = useSyncExternalStore(
    chat?.subscribe ?? noSubscription,
    () => chat?.getSnapshot().selected ?? null,
  );
  let place: Place | null = null;
  if (!project) place = chat ? { kind: 'chat', chat: chatSelected } : null;
  else place = { kind: 'project', checkoutId: project.checkoutId, path: activePath || null };
  // A project since closed is passed over; a chat or file that has gone drops out once tried.
  const canShow = (candidate: Place) =>
    candidate.kind === 'chat'
      ? !!chat
      : openCheckouts.some((checkout) => checkout.checkoutId === candidate.checkoutId);
  const { navigation } = application.service;
  const history = useAtomValue(application.atoms.history);
  const placeKey = place && JSON.stringify(place);
  useEffect(() => {
    void application.run(navigation.show(place));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- The key stands for the place.
  }, [placeKey]);
  const stepTo = (index: number | undefined) => {
    const target = index === undefined ? undefined : history.places[index];
    if (index === undefined || !target) return undefined;
    const go = Effect.tryPromise({ try: () => show(target), catch: (error) => error }).pipe(
      Effect.catch((error) => Effect.sync(() => report(error))),
    );
    return () => void application.run(navigation.step(index, go)).catch(report);
  };
  return {
    /** Steps back or forward, absent when there is nowhere to go. */
    back: stepTo(findStep(history, -1, canShow)),
    forward: stepTo(findStep(history, 1, canShow)),
  };
}
