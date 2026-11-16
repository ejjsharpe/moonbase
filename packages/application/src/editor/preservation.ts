import { Deferred, Effect } from 'effect';
import {
  ApplicationError,
  type CheckoutTarget,
  type FileDocument,
  type FileTarget,
} from '@moonbase/contracts/workspace';
import type { CloseChoice, ClosePrompt, EditorBuffer } from './editor.ts';
import { checkoutKey, fileKey, type ClosedAction } from './references.ts';

type PreservationDependencies = {
  run<A>(effect: Effect.Effect<A, ApplicationError>): Promise<A>;
  isClosing(): boolean;
  invalidateReads(): void;
  notify(): void;
  report(error: unknown): void;
  afterRelease(): Promise<void>;
};
/** What a close settled: the files it closes, and those whose drafts were discarded. */
export type ConfirmedClose = {
  targets: readonly FileTarget[];
  discarded: ReadonlySet<string>;
  kind: 'files' | 'checkout' | 'quit';
  checkout?: CheckoutTarget;
};
type CloseCapabilities = {
  captureBuffer(target: FileTarget): EditorBuffer | undefined;
  saveFile(target: FileTarget): Promise<boolean>;
  /** Closes the files in the recovery store and then in the editor; returns what was closed. */
  closeFiles(result: ConfirmedClose): Promise<ClosedAction[]>;
};
type ReloadCapabilities = {
  readFile(target: FileTarget): Promise<FileDocument>;
  isCurrent(): boolean;
  /** Discards the buffer's draft in the recovery store, then shows `disk`. */
  reloadFile(disk: FileDocument): Promise<void>;
};
const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) => checkoutKey(a) === checkoutKey(b);

/** One captured close or reload: its prompt, and the closed files it remembers for Reopen. */
export class EditorPreservation {
  private preserving = false;
  private closePrompt: ClosePrompt | null = null;
  private closeAnswer?: Deferred.Deferred<CloseChoice>;
  private history: ClosedAction[] = [];
  private dependencies: PreservationDependencies;
  constructor(dependencies: PreservationDependencies) {
    this.dependencies = dependencies;
  }
  get active() {
    return this.preserving;
  }
  get prompt() {
    return this.closePrompt;
  }
  private begin() {
    this.preserving = true;
    this.dependencies.invalidateReads();
    this.dependencies.notify();
  }
  private async release() {
    if (this.dependencies.isClosing()) return;
    this.preserving = false;
    this.dependencies.notify();
    await this.dependencies.afterRelease();
  }
  answer(promptId: string, choice: CloseChoice) {
    if (
      !this.closeAnswer ||
      this.closePrompt?.id !== promptId ||
      !['save', 'discard', 'cancel'].includes(choice)
    )
      return;
    Deferred.doneUnsafe(this.closeAnswer, Effect.succeed(choice));
  }
  cancelPrompt() {
    this.closePrompt = null;
    if (this.closeAnswer) Deferred.doneUnsafe(this.closeAnswer, Effect.succeed('cancel'));
    this.closeAnswer = undefined;
  }
  private async choose(buffer: EditorBuffer) {
    const answer = Deferred.makeUnsafe<CloseChoice>();
    const prompt = { id: crypto.randomUUID(), buffer };
    this.closeAnswer = answer;
    this.closePrompt = prompt;
    this.dependencies.notify();
    const choice = await this.dependencies.run(Deferred.await(answer));
    if (this.closePrompt?.id === prompt.id) {
      this.closePrompt = null;
      this.closeAnswer = undefined;
      this.dependencies.notify();
    }
    return choice;
  }
  async reload(target: FileTarget, capabilities: ReloadCapabilities) {
    this.begin();
    try {
      const disk = await capabilities.readFile(target);
      if (this.dependencies.isClosing() || !capabilities.isCurrent())
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'The file changed while it was reloading. Edits retained; retry.',
        });
      await capabilities.reloadFile(disk);
      return true;
    } finally {
      if (this.preserving) await this.release();
    }
  }
  /**
   * Asks Save, Discard or Cancel for each file with unsaved changes, then closes the files. Their
   * drafts are kept until the store has committed each close, so a failure loses nothing.
   */
  async close(
    targets: FileTarget[],
    kind: ConfirmedClose['kind'],
    checkout: CheckoutTarget | undefined,
    capabilities: CloseCapabilities,
  ) {
    this.begin();
    const discarded = new Set<string>();
    try {
      for (const target of targets) {
        const buffer = capabilities.captureBuffer(target);
        if (!buffer || buffer.text === buffer.disk.text) continue;
        const choice = await this.choose(buffer);
        if (this.dependencies.isClosing() || choice === 'cancel') return false;
        if (choice === 'discard') discarded.add(fileKey(target));
        else if (!(await capabilities.saveFile(target))) return false;
      }
      const closed = await capabilities.closeFiles({ targets, discarded, kind, checkout });
      if (kind !== 'quit') this.history = [...this.history, ...closed].slice(-20);
      return true;
    } catch (error) {
      this.dependencies.report(error);
      return false;
    } finally {
      if (this.preserving) await this.release();
    }
  }
  findClosedAction(checkout: CheckoutTarget) {
    const index = this.history.findLastIndex((action) => sameCheckout(action.checkout, checkout));
    return index < 0 ? undefined : { index, action: structuredClone(this.history[index]) };
  }
  forgetClosedAction(index: number) {
    this.history.splice(index, 1);
  }
  removeTrashedReferences(checkout: CheckoutTarget, source: string) {
    this.history = this.history.flatMap((action) => {
      if (!sameCheckout(action.checkout, checkout)) return [action];
      action.files = action.files.filter(
        (file) => file.path !== source && !file.path.startsWith(source + '/'),
      );
      return action.files.length ? [action] : [];
    });
  }
  rebindClosedReferences(previous: CheckoutTarget, next: CheckoutTarget) {
    for (const action of this.history)
      if (sameCheckout(action.checkout, previous)) action.checkout = next;
  }
  moveClosedReferences(checkout: CheckoutTarget, source: string, destination: string) {
    const move = (path: string) =>
      path === source || path.startsWith(source + '/')
        ? destination + path.slice(source.length)
        : path;
    for (const action of this.history)
      if (sameCheckout(action.checkout, checkout)) {
        action.active = move(action.active);
        action.files = action.files.map((file) => ({ ...file, path: move(file.path) }));
      }
  }
}
