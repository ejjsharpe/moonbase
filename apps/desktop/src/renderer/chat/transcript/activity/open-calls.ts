import * as Atom from 'effect/reactivity/Atom';

/**
 * Which tool calls are open, in one transcript. A call and its output are separate rows: the
 * call's step publishes whether it is open, and the output's step, which shows no line of its own
 * while the call's entry is retained, opens with it. An output open on its own (Find revealing a
 * match in it) shows its call open too, and folding the call asks those outputs to fold. Keys are
 * `entryId\npartId` of the call.
 */
type OpenCallsState = {
  readonly open: ReadonlySet<string>;
  /** Each output step open on its own, by its step's ID: its call's key. */
  readonly outputs: ReadonlyMap<string, string>;
  /** How many times each call asked its outputs to fold. */
  readonly folds: ReadonlyMap<string, number>;
};

/** The transcript's open calls; the transcript mounts `state` for as long as it shows. */
export function makeOpenCalls() {
  const empty: OpenCallsState = { open: new Set(), outputs: new Map(), folds: new Map() };
  const state = Atom.make(empty);
  return {
    state,
    isOpen: Atom.family((key: string) => Atom.readable((get) => get(state).open.has(key))),
    isOutputOpen: Atom.family((key: string) =>
      Atom.readable((get) => [...get(state).outputs.values()].includes(key)),
    ),
    folds: Atom.family((key: string) => Atom.readable((get) => get(state).folds.get(key) ?? 0)),
  };
}
export type OpenCalls = ReturnType<typeof makeOpenCalls>;

/** Records whether the call `key` is open. */
export const setCallOpen =
  (key: string, open: boolean) =>
  (state: OpenCallsState): OpenCallsState => {
    if (state.open.has(key) === open) return state;
    const next = new Set(state.open);
    if (open) next.add(key);
    else next.delete(key);
    return { ...state, open: next };
  };

/** Records whether the output step `id` of the call `key` is open on its own. */
export const setOutputOpen =
  (id: string, key: string, open: boolean) =>
  (state: OpenCallsState): OpenCallsState => {
    if ((state.outputs.get(id) === key) === open) return state;
    const outputs = new Map(state.outputs);
    if (open) outputs.set(id, key);
    else outputs.delete(id);
    return { ...state, outputs };
  };

/** Asks the outputs open on their own of the call `key` to fold. */
export const foldOutputs =
  (key: string) =>
  (state: OpenCallsState): OpenCallsState => ({
    ...state,
    folds: new Map(state.folds).set(key, (state.folds.get(key) ?? 0) + 1),
  });
