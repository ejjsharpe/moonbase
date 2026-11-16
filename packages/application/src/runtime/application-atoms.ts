import * as Atom from 'effect/reactivity/Atom';
import type { MoonbaseApplicationShape } from './application-service.ts';
import { toApplicationSnapshot } from './application-service.ts';

/** Atoms over the application's phase and the chat it shows. */
export function makeApplicationAtoms(application: MoonbaseApplicationShape) {
  const phase = Atom.subscriptionRef(application.phase);
  const chat = Atom.subscriptionRef(application.chat.state);
  return {
    snapshot: Atom.readable((get) =>
      toApplicationSnapshot(get(phase), get(chat), application.chat.targets),
    ),
    chat: Atom.readable((get) => get(chat).controller),
  };
}
export type ApplicationAtoms = ReturnType<typeof makeApplicationAtoms>;
