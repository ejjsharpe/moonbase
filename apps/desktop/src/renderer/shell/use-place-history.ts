import { useEffect } from 'react';
import * as Atom from 'effect/reactivity/Atom';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { useAtomValue } from '@effect/atom-react';
import { type Context, Effect } from 'effect';
import { findStep, type Place } from '@moonbase/application';
import { getChatAtoms, type ChatServices } from '@moonbase/application/chat';
import type { ChatTarget } from '@moonbase/contracts/chat';
import type { DesktopApplication } from './desktop-application.ts';
import { reporting, useRun } from '../hooks/use-run.ts';

const noChat = Atom.make<ChatTarget | null>(null);

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
  /** The open chat's services, or null while no chat is open. */
  chat: Context.Context<ChatServices> | null;
  /** The project showing, absent while Agents shows. */
  project: CheckoutTarget | undefined;
  activePath: string | null | undefined;
  openCheckouts: readonly CheckoutTarget[];
  show(place: Place): Effect.Effect<void, unknown>;
  report(error: unknown): void;
}) {
  const chatSelected = useAtomValue(chat ? getChatAtoms(chat).selected : noChat);
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
  // A step still showing its place ends with the shell.
  const run = useRun();
  useEffect(() => {
    run(navigation.show(place));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- The key stands for the place.
  }, [placeKey]);
  const stepTo = (index: number | undefined) => {
    const target = index === undefined ? undefined : history.places[index];
    if (index === undefined || !target) return undefined;
    const go = Effect.catch(show(target), (error) => Effect.sync(() => report(error)));
    return () => run(reporting(navigation.step(index, go), report));
  };
  return {
    /** Steps back or forward, absent when there is nowhere to go. */
    back: stepTo(findStep(history, -1, canShow)),
    forward: stepTo(findStep(history, 1, canShow)),
  };
}
