// Public-entry smoke fixture: retain executable factories in the emitted browser graph.
export {
  makeChatModel,
  makeChatController,
  iterateTranscriptSource,
  makeTranscriptReader,
} from '@moonbase/application/chat';
export { makeEditorModel, makeEditorController } from '@moonbase/application/editor';
export { makeChatClient, makeEditorClient } from '@moonbase/application/runtime/clients';
export {
  runApplicationEffect,
  observeApplicationStream,
} from '@moonbase/application/runtime/effect-client';
export { ApplicationError } from '@moonbase/contracts/errors';
export { WorkspaceService, ConnectionService, ChatService } from '@moonbase/contracts/services';
export { decodeChatInput } from '@moonbase/contracts/chat';
export { checkHeadlessApplication } from '../../packages/application/examples/headless.ts';
