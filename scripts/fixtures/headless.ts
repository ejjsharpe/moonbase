// Public-entry smoke fixture: retain executable factories in the emitted browser graph.
export { makeChatModel, makeChatController } from '@moonbase/chat';
export { makeEditorModel, makeEditorController } from '@moonbase/editor/state';
export { makeChatClient, makeEditorClient } from '@moonbase/application/runtime-client';
export {
  runApplicationEffect,
  observeApplicationStream,
} from '@moonbase/application/effect-client';
