import { Effect, Layer, Scope } from 'effect';
import { DesktopChatRpcs } from '../../ipc/chat-rpcs.ts';
import { EditorRpcs } from '../../ipc/editor-rpcs.ts';
import { IpcAdmission } from '../../ipc/ipc-admission.ts';
import { WindowRpcs } from '../../ipc/window-rpcs.ts';
import type { ChatDocuments } from '../chat/chat-document.ts';
import type { WindowLifecycle } from '../window-lifecycle.ts';
import { makeIpcAdmission, type IpcInterception } from './admission.ts';
import { makeChatIpcHandlers, type ChatIpcOptions } from './chat-ipc.ts';
import { makeEditorIpcHandlers, type EditorIpcOptions } from './editor-ipc.ts';
import { makeWindowIpcHandlers } from './window-ipc.ts';

export type DocumentHandlersOptions = {
  editor: EditorIpcOptions;
  chat: Omit<ChatIpcOptions, 'isQuitting'> & { documents: Pick<ChatDocuments, 'open'> };
  lifecycle: Pick<
    WindowLifecycle['Service'],
    'actions' | 'markReady' | 'answerQuit' | 'isQuitting'
  >;
  intercept?: IpcInterception;
};

/** Every procedure's handlers for one document, and its admission, built in `document`. */
export const makeDocumentHandlers = (options: DocumentHandlersOptions) => (document: Scope.Scope) =>
  Layer.mergeAll(
    EditorRpcs.toLayer(makeEditorIpcHandlers(options.editor, document)),
    DesktopChatRpcs.toLayer(
      Effect.map(Scope.provide(options.chat.documents.open, document), (chat) =>
        makeChatIpcHandlers({ ...options.chat, isQuitting: options.lifecycle.isQuitting }, chat),
      ),
    ),
    WindowRpcs.toLayer(makeWindowIpcHandlers(options.lifecycle)),
    Layer.succeed(IpcAdmission, makeIpcAdmission(options.intercept)),
  );
