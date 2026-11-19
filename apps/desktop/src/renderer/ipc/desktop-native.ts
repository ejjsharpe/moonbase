import { Context, Effect, Layer } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { DesktopBridge } from '../../ipc/desktop-bridge.ts';
import type { ChatTargetId } from '../../ipc/chat-rpcs.ts';
import type { DesktopIpc } from './desktop-ipc.ts';
import { callEffect, type Payload, type Refusal, type Tag } from './ipc-failures.ts';

/**
 * Main's native capabilities over this document's IPC port: each method is main's procedure as an
 * Effect, failing with the error main sends or the renderer's own. They return user-approved
 * roots or opaque native references, never source paths.
 */
const makeDesktopNative = (ipc: Context.Context<DesktopIpc>, bridge: DesktopBridge) => {
  const call = <T extends Tag>(tag: T, payload: Payload<T>, refused: Refusal = 'desktop-request') =>
    callEffect(tag, payload, refused).pipe(Effect.provideContext(ipc));
  const transcript = (backendId: ChatTargetId) => ({
    copy: (copy: Payload<'copyTranscript'>['copy']) =>
      call('copyTranscript', { backendId, copy }, 'chat-request'),
    openLink: (url: string) => call('openTranscriptLink', { backendId, url }, 'chat-request'),
    imageUrl: (image: Payload<'getTranscriptImageUrl'>['image']) =>
      call('getTranscriptImageUrl', { backendId, image }, 'chat-request'),
  });
  return {
    /** A local chat's folder, chosen in the native picker; null when the user cancelled. */
    chooseChatFolder: call('chooseChatFolder', undefined),
    /**
     * Folders a new chat on the target may use without a picker: local chat's recently approved
     * ones, or a remote host's approved roots and their folders.
     */
    listChatFolders: (backendId: ChatTargetId) => call('listChatFolders', { backendId }),
    /** Creates a new local chat's linked worktree beside the repository, returning its root. */
    createChatWorktree: (root: string, branch: string, requestId: string) =>
      call('createChatWorktree', { root, branch, requestId }),
    /** Opens a local chat without a project's folder as a project where it is, returning its root. */
    turnChatIntoProject: (conversationId: string) =>
      call('turnChatIntoProject', { conversationId }),
    /** A project's root, chosen in the native picker; null when the user cancelled. */
    chooseCheckout: call('chooseCheckout', undefined),
    /** Files copied in the OS, approved for importing into `checkout`. */
    pasteImports: (checkout: CheckoutTarget) => call('pasteImports', { checkout }),
    /** Imports dropped files; a drop with no file main can read imports nothing. */
    dropImports: (checkout: CheckoutTarget, files: File[]) =>
      Effect.map(
        call('dropImports', {
          checkout,
          paths: files.map((file) => bridge.pathForFile(file)).filter(Boolean),
        }),
        (references) => references ?? [],
      ),
    copyPaths: (checkout: CheckoutTarget, paths: string[], relative: boolean) =>
      call('copyPaths', { checkout, paths, relative }),
    revealPath: (checkout: CheckoutTarget, path: string) => call('revealPath', { checkout, path }),
    /**
     * Each chat target's transcript native actions, made once, so a change of the selected target
     * cannot reroute a pending action.
     */
    transcripts: { local: transcript('local'), remote: transcript('remote') },
  };
};
export type DesktopNativeShape = ReturnType<typeof makeDesktopNative>;

/** Main's native capabilities, as the renderer's views run them. */
export class DesktopNative extends Context.Service<DesktopNative, DesktopNativeShape>()(
  'moonbase/desktop/renderer/DesktopNative',
) {
  /** Over the document's IPC port; `bridge` reads a dropped file's path. */
  static readonly layer = (bridge: DesktopBridge) =>
    Layer.effect(
      DesktopNative,
      Effect.map(Effect.context<DesktopIpc>(), (ipc) => makeDesktopNative(ipc, bridge)),
    );
}
