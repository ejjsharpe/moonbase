export {
  makeEditorModel,
  makeEditorController,
  type EditorController,
  type EditorModel,
  type EditorDependencies,
  type RevealOptions,
  checkoutKey,
  fileKey,
  type EditorSnapshot,
  type EditorBuffer,
  type ClosePrompt,
  type CloseChoice,
} from './features/editor/editor.ts';
export type {
  EditorLookup,
  EditorMutation,
  EditorTextSearch,
  LookupRow,
  LookupSnapshot,
  TextSearchOptions,
  TextSearchSnapshot,
  MutationAction,
  MutationSnapshot,
} from './features/editor/workflows.ts';
export { readOwn } from './features/editor/record.ts';
export { runMutation, type MutationRunResult } from './features/editor/run-mutation.ts';
