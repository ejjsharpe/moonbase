import { Layer, type PubSub, type Scope } from 'effect';
import { DesktopChatRpcs } from '../../ipc/chat-rpcs.ts';
import { EditorRpcs } from '../../ipc/editor-rpcs.ts';
import { IpcAdmission } from '../../ipc/ipc-admission.ts';
import { WindowRpcs, type WindowAction } from '../../ipc/window-rpcs.ts';
import type { WindowLifecycle } from '../window-lifecycle.ts';
import { makeIpcAdmission, type IpcInterception } from './admission.ts';
import { makeChatIpcHandlers, type ChatIpcOptions } from './chat-ipc.ts';
import { makeEditorIpcHandlers, type EditorIpcOptions } from './editor-ipc.ts';
import { makeWindowIpcHandlers } from './window-ipc.ts';

export type DocumentHandlersOptions = {
  editor: EditorIpcOptions;
  chat: ChatIpcOptions;
  /** The window's actions, which each document watching for them hears. */
  actions: PubSub.PubSub<WindowAction>;
  lifecycle(): Pick<WindowLifecycle, 'markReady' | 'answerQuit'>;
  intercept?: IpcInterception;
};

/** Every procedure's handlers for one document, and its admission, built in `document`. */
export const makeDocumentHandlers = (options: DocumentHandlersOptions) => (document: Scope.Scope) =>
  Layer.mergeAll(
    EditorRpcs.toLayer(makeEditorIpcHandlers(options.editor, document)),
    DesktopChatRpcs.toLayer(makeChatIpcHandlers(options.chat)),
    WindowRpcs.toLayer(makeWindowIpcHandlers(options.actions, options.lifecycle)),
    Layer.succeed(IpcAdmission, makeIpcAdmission(options.intercept)),
  );
