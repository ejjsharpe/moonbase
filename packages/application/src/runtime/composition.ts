import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { normalizeApplicationError } from '@moonbase/effect';
import {
  makeEditorController,
  makeEditorModel,
  type EditorController,
  type EditorDependencies,
  type EditorModel,
} from '../features/editor/index.ts';
import {
  makeChatController,
  makeChatModel,
  type ChatController,
  type ChatDependencies,
  type ChatModel,
} from '../features/chat/index.ts';
import { runApplicationEffect } from './effect-client.ts';
import { ApplicationCleanup, releaseInstance } from './lifecycle.ts';

export type MoonbaseApplicationOptions = {
  editors?: readonly EditorDependencies[];
  chat?: () => Promise<ChatDependencies | null>;
};
export type ApplicationPhase =
  | 'live'
  | 'preparing'
  | 'prepared'
  | 'disposing'
  | 'disposed'
  | 'failed';
export type ApplicationChatStatus =
  | 'unavailable'
  | 'opening'
  | 'ready'
  | 'closed'
  | 'initialization-failed'
  | 'cleanup-blocked';
export type MoonbaseApplicationSnapshot = {
  phase: ApplicationPhase;
  chat: { state: ApplicationChatStatus; error: string | null };
  cleanup: { pending: readonly string[]; errors: readonly string[] };
};
type EditorInstance = { model: EditorModel; controller: EditorController; scope: Scope.Closeable };
type ChatInstance = { model: ChatModel; controller: ChatController; scope: Scope.Closeable };
const closing = () =>
  new ApplicationError({ code: 'Unavailable', message: 'Application is closing.' });
function failures(errors: unknown[]): ApplicationError {
  const normalized = errors.map(normalizeApplicationError);
  return new ApplicationError({
    code: normalized[0]?.code ?? 'Unavailable',
    message: normalized
      .map((error) => error.message)
      .join('; ')
      .slice(0, 512),
  });
}

class Application {
  private controllers: EditorController[] = [];
  get editors(): readonly EditorController[] {
    return this.controllers;
  }
  private instances: EditorInstance[] = [];
  private currentChat: ChatInstance | null = null;
  private runtime = ManagedRuntime.make(Layer.empty);
  private scope = Scope.makeUnsafe('parallel');
  private cleanup = new ApplicationCleanup(this.runtime, this.scope);
  private options: MoonbaseApplicationOptions;
  private phase: ApplicationPhase = 'live';
  private chatState: ApplicationChatStatus = 'unavailable';
  private chatFailure: ApplicationError | null = null;
  private listeners = new Set<() => void>();
  private snapshot!: MoonbaseApplicationSnapshot;
  private opening?: Promise<ChatController | null>;
  private preparation?: Promise<boolean>;
  private disposal?: Promise<void>;
  private consented = false;
  private closingChat = false;
  private checkingUnload = false;
  constructor(options: MoonbaseApplicationOptions) {
    this.options = {
      editors: options.editors?.map((editor) => ({ ...editor })),
      chat: options.chat,
    };
    this.cleanup.subscribe(() => this.publish());
    this.publish();
  }
  get chat(): ChatController | null {
    return this.currentChat?.controller ?? null;
  }
  getSnapshot = (): MoonbaseApplicationSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    if (this.phase === 'disposed' || this.phase === 'failed') return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    this.snapshot = {
      phase: this.phase,
      chat: { state: this.chatState, error: this.chatFailure?.message ?? null },
      cleanup: this.cleanup.getSnapshot(),
    };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A view cannot interrupt owned lifecycle work. */
      }
    }
  }
  reportCleanup(error: unknown) {
    this.cleanup.report(error);
  }
  private fence(open: boolean) {
    for (const instance of this.instances) instance.model.setAdmissionsOpen(open);
    this.currentChat?.model.setAdmissionsOpen(open);
  }
  async initialize() {
    for (const dependencies of this.options.editors ?? []) {
      const scope = Scope.forkUnsafe(this.scope, 'parallel');
      const model = await runApplicationEffect(
        this.runtime,
        makeEditorModel(dependencies).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      const controller = makeEditorController(this.runtime, model);
      this.cleanup.claim(`editor:${model.clientId}`);
      this.instances.push({ model, controller, scope });
      this.controllers.push(controller);
      await controller.load();
    }
    if (this.options.chat) {
      await this.openChat();
      if (!this.instances.length && !this.currentChat)
        throw (
          this.chatFailure ??
          new ApplicationError({ code: 'Unavailable', message: 'Chat is unavailable.' })
        );
    }
  }
  openChat(): Promise<ChatController | null> {
    if (this.phase !== 'live' || this.checkingUnload) return Promise.reject(closing());
    if (this.opening) return this.opening;
    if (this.currentChat) return Promise.resolve(this.currentChat.controller);
    if (!this.options.chat) return Promise.resolve(null);
    if (!this.cleanup.available('chat'))
      return Promise.reject(
        new ApplicationError({
          code: 'Unavailable',
          message: 'Chat still owns unfinished cleanup. Quit and recover before reopening it.',
        }),
      );
    this.cleanup.claim('chat');
    const result = Promise.withResolvers<ChatController | null>();
    this.opening = result.promise;
    this.chatState = 'opening';
    this.chatFailure = null;
    this.publish();
    void this.acquireChat().then(
      (controller) => {
        this.opening = undefined;
        result.resolve(controller);
      },
      (error) => {
        this.opening = undefined;
        result.reject(normalizeApplicationError(error));
      },
    );
    return result.promise;
  }
  private releasing() {
    return this.phase === 'disposing' || this.phase === 'disposed' || this.phase === 'failed';
  }
  private async acquireChat(): Promise<ChatController | null> {
    const scope = Scope.forkUnsafe(this.scope, 'parallel');
    let model: ChatModel | undefined;
    try {
      const dependencies = await this.options.chat!();
      if (dependencies && !this.releasing()) {
        model = await runApplicationEffect(
          this.runtime,
          makeChatModel(dependencies).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        const controller = makeChatController(this.runtime, model);
        if (!this.releasing()) {
          this.currentChat = { model, controller, scope };
          this.chatState = 'ready';
          this.publish();
          return this.currentChat?.controller === controller ? controller : null;
        }
      }
      await this.cleanup.close('chat', () =>
        releaseInstance(this.runtime, scope, () => model?.dispose() ?? Promise.resolve()),
      );
      if (this.phase !== 'disposing') {
        this.chatState = 'unavailable';
        this.publish();
      }
      return null;
    } catch (error) {
      const errors: unknown[] = [error];
      this.chatState = 'initialization-failed';
      try {
        await this.cleanup.close('chat', () =>
          releaseInstance(this.runtime, scope, () => model?.dispose() ?? Promise.resolve()),
        );
      } catch (release) {
        errors.push(release);
        this.chatState = 'cleanup-blocked';
      }
      this.chatFailure = failures(errors);
      this.publish();
      return null;
    }
  }
  closeChat(): boolean {
    if (this.phase !== 'live' || !this.currentChat || this.closingChat || this.checkingUnload)
      return false;
    this.closingChat = true;
    const instance = this.currentChat;
    instance.model.setAdmissionsOpen(false);
    try {
      if (!instance.controller.preserve() || this.phase !== 'live' || this.currentChat !== instance)
        return false;
      this.currentChat = null;
      this.chatState = 'closed';
      const close = this.cleanup.close('chat', () =>
        releaseInstance(this.runtime, instance.scope, () => instance.controller.dispose()),
      );
      void close.catch((error) => {
        this.chatState = 'cleanup-blocked';
        this.chatFailure = normalizeApplicationError(error);
        this.publish();
      });
      this.publish();
      return true;
    } finally {
      if (this.phase === 'live' && this.currentChat === instance)
        instance.model.setAdmissionsOpen(true);
      this.closingChat = false;
    }
  }
  canUnload(): boolean {
    if (this.consented) return true;
    if (
      this.checkingUnload ||
      this.closingChat ||
      this.phase !== 'live' ||
      this.opening ||
      this.chatState === 'initialization-failed' ||
      this.chatState === 'cleanup-blocked'
    )
      return false;
    if (
      this.cleanup.getSnapshot().pending.length ||
      this.instances.some(({ controller }) => !controller.getSnapshot().recoveryReady)
    )
      return false;
    this.checkingUnload = true;
    this.fence(false);
    try {
      return (
        (this.chat?.preserve() ?? true) &&
        this.phase === 'live' &&
        this.instances.every(({ controller }) => controller.getSnapshot().recoveryReady)
      );
    } finally {
      if (this.phase === 'live') this.fence(true);
      this.checkingUnload = false;
    }
  }
  prepareQuit(): Promise<boolean> {
    if (this.preparation) return this.preparation;
    if (this.checkingUnload) return Promise.resolve(false);
    if (this.phase === 'prepared') return Promise.resolve(true);
    if (this.phase !== 'live') return Promise.resolve(false);
    const result = Promise.withResolvers<boolean>();
    this.preparation = result.promise;
    this.phase = 'preparing';
    this.publish();
    void this.prepare().then(
      (consent) => {
        if (!consent) this.preparation = undefined;
        result.resolve(consent);
      },
      (error) => {
        this.cleanup.report(error);
        this.restore();
        this.preparation = undefined;
        result.resolve(false);
      },
    );
    return result.promise;
  }
  private restore() {
    if (this.phase !== 'preparing') return;
    this.fence(true);
    this.phase = 'live';
    this.publish();
  }
  private async prepare(): Promise<boolean> {
    if (this.opening) await this.opening;
    if (this.phase !== 'preparing') return false;
    const chat = this.currentChat;
    chat?.model.setAdmissionsOpen(false);
    const preserved = chat?.controller.preserve() ?? true;
    if (this.phase === 'preparing') chat?.model.setAdmissionsOpen(true);
    if (this.chatState === 'initialization-failed' || !preserved) {
      this.restore();
      return false;
    }
    for (const { controller, model } of this.instances) {
      if (this.phase !== 'preparing' || !(await controller.prepareQuit())) {
        this.restore();
        return false;
      }
      model.setAdmissionsOpen(false);
      if (!(await model.finishQuitPreparation())) {
        this.restore();
        return false;
      }
    }
    if (this.phase !== 'preparing') return false;
    this.fence(false);
    if (
      (this.chat && !this.chat.preserve()) ||
      this.instances.some(({ controller }) => !controller.getSnapshot().recoveryReady)
    ) {
      this.restore();
      return false;
    }
    if (this.phase !== 'preparing') return false;
    this.consented = true;
    this.phase = 'prepared';
    this.publish();
    return this.phase === 'prepared';
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    const result = Promise.withResolvers<void>();
    this.disposal = result.promise;
    this.phase = 'disposing';
    this.fence(false);
    for (const { model, controller, scope } of this.instances)
      void this.cleanup.close(`editor:${model.clientId}`, () =>
        releaseInstance(this.runtime, scope, () => controller.dispose()),
      );
    const chat = this.currentChat;
    this.currentChat = null;
    if (chat)
      void this.cleanup.close('chat', () =>
        releaseInstance(this.runtime, chat.scope, () => chat.controller.dispose()),
      );
    this.publish();
    void this.release().then(
      () => {
        this.phase = 'disposed';
        this.publish();
        this.listeners.clear();
        result.resolve();
      },
      (error) => {
        this.phase = 'failed';
        this.publish();
        this.listeners.clear();
        result.reject(error);
      },
    );
    return result.promise;
  }
  private async release() {
    const errors: unknown[] = [];
    for (const release of [
      async () => {
        await this.opening;
      },
      () => this.cleanup.drain(),
      () => runApplicationEffect(this.runtime, Scope.close(this.scope, Exit.void)),
      () => runApplicationEffect(this.runtime, this.runtime.disposeEffect),
    ]) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw failures(errors);
  }
}

export type MoonbaseApplication = Pick<
  Application,
  | 'editors'
  | 'chat'
  | 'getSnapshot'
  | 'subscribe'
  | 'reportCleanup'
  | 'openChat'
  | 'closeChat'
  | 'canUnload'
  | 'prepareQuit'
  | 'dispose'
>;

/** Owns client model lifetimes only; capabilities and privileged process roots remain injected. */
export async function createMoonbaseApplication(
  options: MoonbaseApplicationOptions,
): Promise<MoonbaseApplication> {
  if (!options.editors?.length && !options.chat)
    throw new ApplicationError({
      code: 'InvalidInput',
      message: 'Supply an editor or chat capability.',
    });
  const ids = (options.editors ?? []).flatMap((editor) =>
    editor.clientId === undefined ? [] : [editor.clientId],
  );
  if (new Set(ids).size !== ids.length)
    throw new ApplicationError({
      code: 'InvalidInput',
      message: 'Each editor requires a distinct recovery namespace.',
    });
  const application = new Application(options);
  try {
    await application.initialize();
    return application;
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      await application.dispose();
    } catch (release) {
      errors.push(release);
    }
    throw failures(errors);
  }
}
