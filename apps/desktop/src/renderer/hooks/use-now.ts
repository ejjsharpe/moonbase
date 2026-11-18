import { Clock, Schedule, Stream } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useAtomValue } from '@effect/atom-react';

/**
 * The time now in milliseconds, from `Clock`: read at once, then every `everyMs` while a view
 * reads it. Read outside a view, it is the time of that read.
 */
export const nowAtom = Atom.family((everyMs: number) =>
  Atom.make(Stream.fromEffectSchedule(Clock.currentTimeMillis, Schedule.spaced(everyMs))),
);
const stopped = Atom.make(AsyncResult.initial<number>());

/** The time now, read every `everyMs`; undefined while `everyMs` is. */
export const useNow = (everyMs: number | undefined) =>
  AsyncResult.getOrElse(
    useAtomValue(everyMs === undefined ? stopped : nowAtom(everyMs)),
    () => undefined,
  );
