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

type DirectMutationDependencies = {
  /** The editor's state the gate reads: whether it is ready and not closing or preserving. */
  state(): { ready: boolean; closing: boolean; preserving: boolean; recovery: EditorRecovery };
  createMutation(action: MutationAction): EditorMutation;
  /** Runs in the editor's scope, so disposing the editor interrupts it. */
  run<A>(effect: Effect.Effect<A, ApplicationError>): Promise<A>;
  notify(): void;
  report(error: unknown): void;
};

/**
 * The editor's direct mutations, run without a dialog: one at a time, asking through
 * `prompt` only before replacing existing entries.
 */
export class DirectMutations {
  private dependencies: DirectMutationDependencies;
  private active = false;
  private replacement?: { prompt: ReplacePrompt; answer: Deferred.Deferred<boolean> };
  constructor(dependencies: DirectMutationDependencies) {
    this.dependencies = dependencies;
  }
  /** Whether a direct mutation is running, including while it asks. */
  get running() {
    return this.active;
  }
  get prompt() {
    return this.replacement?.prompt ?? null;
  }
  /** The mutation gate: the editor is ready and idle, the checkout is open and the action fits. */
  admits(action: MutationAction) {
    const { ready, closing, preserving, recovery } = this.dependencies.state();
    return (
      ready &&
      !closing &&
      !preserving &&
      !this.active &&
      recovery.openCheckoutIds.includes(action.checkout.checkoutId) &&
      recovery.checkouts.some((target) => checkoutKey(target) === checkoutKey(action.checkout)) &&
      // Several entries move or copy into one folder, as a drag from the tree does.
      (!(action.kind === 'move' || action.kind === 'copy') ||
        (action.paths.length >= 1 && action.paths.length <= maxMutationEntries)) &&
      (action.kind !== 'trash' || action.paths.length > 0)
    );
  }
  /**
   * Applies `action` to `destination` if the gate admits it, asking before it replaces anything.
   * It never rejects: a refusal or failure is the result's `error`. The mutation is disposed
   * exactly once; disposing the editor ends it as declined.
   */
  run(action: MutationAction, destination: string): Promise<MutationRunResult> {
    if (!this.admits(action))
      return Promise.resolve({ completed: false, error: mutationUnavailable, items: [] });
    this.active = true;
    this.dependencies.notify();
    return this.dependencies.run(this.apply(action, destination)).catch((error: unknown) => ({
      completed: false,
      error: this.dependencies.state().closing ? '' : normalizeApplicationError(error).message,
      items: [],
    }));
  }
  answer(promptId: string, replace: boolean) {
    const replacement = this.replacement;
    if (replacement?.prompt.id !== promptId) return;
    this.replacement = undefined;
    Deferred.doneUnsafe(replacement.answer, Effect.succeed(replace === true));
    this.dependencies.notify();
  }
  /** Declines a pending prompt as the editor closes. */
  cancel() {
    const replacement = this.replacement;
    this.replacement = undefined;
    if (replacement) Deferred.doneUnsafe(replacement.answer, Effect.succeed(false));
  }
  private apply(action: MutationAction, destination: string) {
    const { createMutation, report } = this.dependencies;
    return Effect.acquireUseRelease(
      Effect.try({ try: () => createMutation(action), catch: normalizeApplicationError }),
      (mutation) => this.complete(mutation, destination),
      (mutation) =>
        Effect.tryPromise({ try: () => mutation.dispose(), catch: normalizeApplicationError }).pipe(
          Effect.catch((error) => Effect.sync(() => report(error))),
        ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.active = false;
          this.dependencies.notify();
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
      if (completed || this.dependencies.state().closing)
        return { completed, error: '', items: items() };
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
      if (this.dependencies.state().closing) return false;
      const answer = yield* Deferred.make<boolean>();
      const prompt = {
        id: crypto.randomUUID(),
        paths: replacements.map((item) => item.target.path),
      };
      this.replacement = { prompt, answer };
      this.dependencies.notify();
      return yield* Deferred.await(answer).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.replacement?.prompt.id !== prompt.id) return;
            this.replacement = undefined;
            this.dependencies.notify();
          }),
        ),
      );
    });
  }
}
