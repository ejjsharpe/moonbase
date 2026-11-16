import { normalizeApplicationError } from '@moonbase/effect';
import { Deferred, Effect } from 'effect';
import type {
  ApplicationError,
  EditorRecovery,
  EntryReference,
  OperationResult,
} from '@moonbase/contracts/workspace';
import { checkoutKey } from './references.ts';
import type { EditorMutation, MutationAction } from './workflows.ts';

/**
 * How a direct mutation ended: done, declined (or ended by disposal) without an error, or failed.
 * `items` are the dispatched operation's per-entry outcomes, empty when none was dispatched; a
 * batch that failed partway lists the entries it did complete.
 */
export type MutationRunResult = {
  completed: boolean;
  error: string;
  items: OperationResult['items'];
};
/** A running direct mutation asks before it replaces these existing entries. */
export type ReplacePrompt = { id: string; paths: string[] };
/** The most entries one move or copy takes. */
export const maxMutationEntries = 128;

/** Why the mutation gate refused an action. */
export const mutationUnavailable =
  'File action unavailable. Check the selection and finish the current editor dialog or preservation.';

/** The direct-mutation fields of the editor's snapshot. */
export type DirectMutationState = {
  /** Whether a direct mutation (`mutations.run`) is running, including while it asks. */
  mutating: boolean;
  replacePrompt: ReplacePrompt | null;
};

/**
 * What the editor controller offers clients as `mutations`:
 * - `admits(action)`: whether `run` would admit `action` now, the one mutation gate;
 * - `run(action, destination)`: runs one file operation without a dialog, one at a time,
 *   publishing `replacePrompt` before it replaces existing entries. It never rejects; a refusal
 *   or failure is the result's `error`;
 * - `answer(promptId, replace)`: answers the replace prompt.
 */
export type DirectMutationControls = Pick<DirectMutations, 'admits' | 'run' | 'answer'>;

/** The editor the mutations run in: its published state, its mutations and its alerts. */
type DirectMutationEditor = {
  getSnapshot(): {
    ready: boolean;
    preserving: boolean;
    closePrompt: unknown;
    recovery: EditorRecovery;
  };
  createMutation(action: MutationAction): EditorMutation;
  report(error: unknown): void;
};
type DirectMutationRuntime = {
  /** Runs in the editor's scope, so disposing the editor interrupts it. */
  run<A>(effect: Effect.Effect<A, ApplicationError>): Promise<A>;
  /** Publishes a new snapshot after `running` or `prompt` change. */
  notify(): void;
};

/**
 * The editor's direct mutations, run without a dialog: one at a time, asking through
 * `prompt` only before replacing existing entries.
 */
export class DirectMutations {
  private editor: DirectMutationEditor;
  private runtime: DirectMutationRuntime;
  private active = false;
  private closed = false;
  private replacement?: { prompt: ReplacePrompt; answer: Deferred.Deferred<boolean> };
  constructor(editor: DirectMutationEditor, runtime: DirectMutationRuntime) {
    this.editor = editor;
    this.runtime = runtime;
  }
  snapshot(): DirectMutationState {
    return { mutating: this.active, replacePrompt: this.replacement?.prompt ?? null };
  }
  /** The mutation gate: the editor is ready and idle, the checkout is open and the action fits. */
  admits = (action: MutationAction) => {
    const { ready, preserving, closePrompt, recovery } = this.editor.getSnapshot();
    return (
      ready &&
      !this.closed &&
      !preserving &&
      !closePrompt &&
      !this.active &&
      recovery.openCheckoutIds.includes(action.checkout.checkoutId) &&
      recovery.checkouts.some((target) => checkoutKey(target) === checkoutKey(action.checkout)) &&
      // Several entries move or copy into one folder, as a drag from the tree does.
      (!(action.kind === 'move' || action.kind === 'copy') ||
        (action.paths.length >= 1 && action.paths.length <= maxMutationEntries)) &&
      (action.kind !== 'trash' || action.paths.length > 0)
    );
  };
  /**
   * Applies `action` to `destination` if the gate admits it, asking before it replaces anything.
   * It never rejects: a refusal or failure is the result's `error`. The mutation is disposed
   * exactly once; disposing the editor ends it as declined.
   */
  run = (action: MutationAction, destination: string): Promise<MutationRunResult> => {
    if (!this.admits(action))
      return Promise.resolve({ completed: false, error: mutationUnavailable, items: [] });
    this.active = true;
    this.runtime.notify();
    return this.runtime.run(this.apply(action, destination)).catch((error: unknown) => ({
      completed: false,
      error: this.closed ? '' : normalizeApplicationError(error).message,
      items: [],
    }));
  };
  answer = (promptId: string, replace: boolean) => {
    const replacement = this.replacement;
    if (replacement?.prompt.id !== promptId) return;
    this.replacement = undefined;
    Deferred.doneUnsafe(replacement.answer, Effect.succeed(replace === true));
    this.runtime.notify();
  };
  /** Refuses further mutations and declines a pending prompt as the editor closes. */
  close() {
    this.closed = true;
    const replacement = this.replacement;
    this.replacement = undefined;
    if (replacement) Deferred.doneUnsafe(replacement.answer, Effect.succeed(false));
  }
  private apply(action: MutationAction, destination: string) {
    const editor = this.editor;
    return Effect.acquireUseRelease(
      Effect.try({ try: () => editor.createMutation(action), catch: normalizeApplicationError }),
      (mutation) => this.complete(mutation, destination),
      (mutation) =>
        Effect.tryPromise({ try: () => mutation.dispose(), catch: normalizeApplicationError }).pipe(
          Effect.catch((error) => Effect.sync(() => editor.report(error))),
        ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.active = false;
          this.runtime.notify();
        }),
      ),
    );
  }
  private complete(mutation: EditorMutation, destination: string) {
    const items = () => structuredClone(mutation.getSnapshot().result?.items ?? []);
    const apply = (consent: boolean) =>
      Effect.tryPromise({
        try: () => mutation.apply(destination, '', consent),
        catch: normalizeApplicationError,
      });
    return Effect.gen({ self: this }, function* () {
      let completed = yield* apply(false);
      const { error, replacements } = mutation.getSnapshot();
      if (!completed && !error && replacements?.length) {
        if (!(yield* this.ask(replacements)))
          return { completed: false, error: '', items: items() };
        completed = yield* apply(true);
      }
      if (completed || this.closed) return { completed, error: '', items: items() };
      return {
        completed: false,
        error: mutation.getSnapshot().error || 'File action unavailable. Try again.',
        items: items(),
      };
    });
  }
  /** Publishes the replace prompt and waits for `answer`, or for `cancel` as the editor closes. */
  private ask(replacements: EntryReference[]) {
    return Effect.gen({ self: this }, function* () {
      if (this.closed) return false;
      const answer = yield* Deferred.make<boolean>();
      const prompt = {
        id: crypto.randomUUID(),
        paths: replacements.map((item) => item.target.path),
      };
      this.replacement = { prompt, answer };
      this.runtime.notify();
      return yield* Deferred.await(answer).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.replacement?.prompt.id !== prompt.id) return;
            this.replacement = undefined;
            this.runtime.notify();
          }),
        ),
      );
    });
  }
}
