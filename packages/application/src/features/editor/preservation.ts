import { Deferred, Effect } from 'effect';
import {
  ApplicationError,
  type CheckoutTarget,
  type EditorRecovery,
  type FileDocument,
  type FileTarget,
} from '@moonbase/contracts/workspace';
import type { CloseChoice, ClosePrompt, EditorBuffer } from './editor.ts';
import { checkoutKey, fileKey, closeRecoveryReferences, type ClosedAction } from './references.ts';
import type { PublicationOptions } from './recovery-publications.ts';

type PreservationDependencies = {
  run<A>(effect: Effect.Effect<A, ApplicationError>): Promise<A>;
  isClosing(): boolean;
  retainsConfirmation(): boolean;
  invalidateReads(kind: 'close' | 'reload'): void;
  notify(): void;
  report(error: unknown): void;
  afterRelease(): Promise<void>;
};
type RecoveryCapture = {
  captureRecovery(): EditorRecovery;
  publishRecovery(state: EditorRecovery, options?: PublicationOptions): Promise<void>;
};
export type ConfirmedClose = {
  targets: readonly FileTarget[];
  discarded: ReadonlySet<string>;
  state: EditorRecovery;
  kind: 'files' | 'checkout' | 'quit';
  checkout?: CheckoutTarget;
};
type CloseCapabilities = RecoveryCapture & {
  captureBuffer(target: FileTarget): EditorBuffer | undefined;
  saveFile(target: FileTarget, generation: number): Promise<boolean>;
  referencesCurrent(): boolean;
  applyConfirmedClose(result: ConfirmedClose): Promise<void>;
};
type ReloadCapabilities = RecoveryCapture & {
  readFile(target: FileTarget): Promise<FileDocument>;
  isCurrent(): boolean;
  applyConfirmedReload(disk: FileDocument): void;
};
const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) => checkoutKey(a) === checkoutKey(b);

/** One captured action owns its prompt, barrier and retained final confirmation. */
export class EditorPreservation {
  private preserving = false;
  private revision = 0;
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
  get generation() {
    return this.revision;
  }
  get prompt() {
    return this.closePrompt;
  }
  private begin(kind: 'close' | 'reload') {
    this.preserving = true;
    this.revision++;
    this.dependencies.invalidateReads(kind);
    this.dependencies.notify();
  }
  async release() {
    if (this.dependencies.isClosing() || this.dependencies.retainsConfirmation()) return;
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
    this.begin('reload');
    const guard = () => {
      if (this.dependencies.isClosing() || !capabilities.isCurrent())
        throw new ApplicationError({
          code: 'Unavailable',
          message:
            'Captured Reload target or recovery revision changed. Edits retained; reconcile and retry.',
        });
    };
    try {
      const disk = await capabilities.readFile(target);
      guard();
      const state = capabilities.captureRecovery();
      state.drafts = state.drafts.filter((item) => fileKey(item.target) !== fileKey(target));
      await capabilities.publishRecovery(state, {
        onConfirmed: async () => {
          capabilities.applyConfirmedReload(disk);
          await this.release();
        },
        kind: 'reload',
        before: guard,
      });
      return true;
    } finally {
      if (this.preserving && !this.dependencies.retainsConfirmation()) await this.release();
    }
  }
  async close(
    targets: FileTarget[],
    kind: ConfirmedClose['kind'],
    checkout: CheckoutTarget | undefined,
    capabilities: CloseCapabilities,
  ) {
    this.begin('close');
    let committed = false;
    const discarded = new Set<string>();
    const checkReferences = () => {
      if (!capabilities.referencesCurrent())
        throw new ApplicationError({
          code: 'Unavailable',
          message:
            'Files moved during the captured close. Edits retained; review their new paths and retry.',
        });
    };
    try {
      for (const target of targets) {
        const buffer = capabilities.captureBuffer(target);
        if (!buffer || buffer.text === buffer.disk.text) continue;
        const choice = await this.choose(buffer);
        if (this.dependencies.isClosing() || choice === 'cancel') return false;
        if (choice === 'discard') discarded.add(fileKey(target));
        else if (!(await capabilities.saveFile(target, this.revision))) return false;
      }
      checkReferences();
      let preflight = capabilities.captureRecovery();
      for (;;) {
        await capabilities.publishRecovery(preflight);
        checkReferences();
        const latest = capabilities.captureRecovery();
        if (JSON.stringify(latest) === JSON.stringify(preflight)) break;
        preflight = latest;
      }
      const state = capabilities.captureRecovery(),
        keys = new Set(targets.map(fileKey));
      state.drafts = state.drafts.filter(
        (draft) =>
          !discarded.has(fileKey(draft.target)) &&
          (kind === 'quit' || !keys.has(fileKey(draft.target))),
      );
      const history = closeRecoveryReferences(state, targets, kind, checkout, true);
      await capabilities.publishRecovery(state, {
        onConfirmed: async () => {
          committed = true; // The exact final receipt is the close outcome; later IO cannot veto it.
          if (kind !== 'quit') this.history = [...this.history, ...history].slice(-20);
          await capabilities.applyConfirmedClose({ targets, discarded, state, kind, checkout });
          await this.release();
        },
      });
      return true;
    } catch (error) {
      this.dependencies.report(error);
      return committed;
    } finally {
      if (this.preserving && !this.dependencies.retainsConfirmation()) await this.release();
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
