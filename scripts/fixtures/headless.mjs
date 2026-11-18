// Public-entry smoke fixture: retain executable factories in the emitted browser graph. It is
// JavaScript so esbuild fails on a re-export that no longer exists; from TypeScript it would
// assume a type and drop it silently.
export {
  chatLayer,
  getChatAtoms,
  readChatState,
  streamTranscriptSource,
} from '@moonbase/application/chat';
export { editorLayer, makeEditorAtoms } from '@moonbase/application/editor';
export { UncertainError } from '@moonbase/contracts/errors';
export { isUncertain } from '@moonbase/contracts/error-groups';
export { WorkspaceService, ConnectionService, ChatService } from '@moonbase/contracts/services';
export { decodeChatInput } from '@moonbase/contracts/chat-schema';
export { checkHeadlessApplication } from '../../packages/application/examples/headless.ts';
