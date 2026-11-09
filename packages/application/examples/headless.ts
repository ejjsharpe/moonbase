import { createMoonbaseApplication } from '@moonbase/application';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  emptyRecovery,
  type CommandInput,
  type EditorClient,
  type RecoveryPublication,
} from '@moonbase/contracts/workspace';
import { chatCapabilities } from '../test/chat-capabilities.ts';

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

// Controlled capability for the commands exercised below.
function editorCapabilities() {
  const checkout = {
    hostId: 'local',
    checkoutId: 'headless',
    projectId: 'example',
    root: '/memory/headless',
    vcs: 'git' as const,
    branch: 'main',
    worktree: 'main' as 'main' | 'linked',
  };
  const target = { checkout, path: 'example.txt' };
  let disk = { text: 'original', version: '0' };
  const publications = new Map<string, RecoveryPublication>();
  const client: EditorClient = {
    async command(operation, input) {
      switch (operation) {
        case 'loadRecovery':
          return {
            revision: 0,
            state: emptyRecovery((input as CommandInput<'loadRecovery'>).clientId),
            errors: [],
            operations: [],
          } as never;
        case 'persistRecovery': {
          const { clientId, requestId, expectedRevision } =
            input as CommandInput<'persistRecovery'>;
          const receipt = {
            clientId,
            requestId,
            previousRevision: expectedRevision,
            revision: expectedRevision + 1,
          };
          publications.set(requestId, receipt);
          return receipt as never;
        }
        case 'getRecoveryPublication':
          return (publications.get((input as CommandInput<'getRecoveryPublication'>).requestId) ??
            null) as never;
        case 'openCheckout':
          return checkout as never;
        case 'readFile':
          return disk as never;
        case 'saveFile':
          disk = {
            text: (input as CommandInput<'saveFile'>).text,
            version: String(Number(disk.version) + 1),
          };
          return { kind: 'saved', disk, recoveryChanges: [] } as never;
        case 'listDirectory':
          return { entries: [{ path: target.path, directory: false }], partial: false } as never;
        case 'getIgnoredPaths':
          return { paths: [] } as never;
        case 'gitStatus':
          return { branch: checkout.branch, changes: [] } as never;
        default:
          throw Error(`Unexpected example operation: ${operation}`);
      }
    },
    watch: () => async () => {},
  };
  return { client, target };
}

/** Direct public API consumer; the same code runs from source and emitted browser-targeted JS. */
export async function checkHeadlessApplication() {
  const completed: string[] = [];
  for (const mode of ['editor', 'chat', 'combined']) {
    const editor = editorCapabilities(),
      chat = chatCapabilities();
    const application = await createMoonbaseApplication({
      editors:
        mode === 'chat' ? undefined : [{ client: editor.client, clientId: `example-${mode}` }],
      chat: mode === 'editor' ? undefined : async () => chat.dependencies,
    });
    const controller = application.editors[0],
      conversation = application.chat;
    let snapshots = 0;
    const changed = () => snapshots++;
    const unsubscribe = [
      application.subscribe(changed),
      controller?.subscribe(changed),
      conversation?.subscribe(changed),
    ];
    try {
      invariant(chat.calls.length === 0, 'Acquisition invoked a remote command');
      if (controller) {
        invariant(controller.getSnapshot().ready, 'Factory did not load editor recovery');
        await controller.openCheckout(editor.target.checkout.root);
        invariant(await controller.open(editor.target), 'Explicit Open did not complete');
        controller.edit(editor.target, 'edited synchronously');
        invariant(controller.buffer(editor.target)?.text === 'edited synchronously', 'Edit lagged');
        invariant(await controller.save(editor.target), 'Explicit Save did not complete');
        await controller.flush();
      }
      if (conversation) {
        await conversation.start();
        invariant(!chat.calls.includes('connect'), 'Observation connected automatically');
        await conversation.connect();
        await conversation.select(chat.target);
        conversation.setDraft('portable draft');
        invariant(conversation.getSnapshot().draft === 'portable draft', 'Draft edit lagged');
        invariant(conversation.preserve(), 'Synchronous preservation vetoed');
        invariant(
          chat.storage.value?.includes('portable draft'),
          'Draft was not written synchronously',
        );
        await conversation.send();
        invariant(chat.calls.includes('sendChat'), 'Explicit Send did not complete');
        const closed = chat.controls.closed;
        await conversation.detach();
        invariant(chat.controls.closed > closed, 'Detach did not await IO observation close');
        await conversation.start();
        await conversation.select(chat.target);
        invariant(
          chat.calls.filter((call) => call === 'sendChat').length === 1,
          'Start replayed Send',
        );
      }
      invariant(snapshots > 0, 'Snapshot subscription delivered no state');
      invariant(application.canUnload(), 'Preserved application vetoed unload');
      for (const off of unsubscribe) off?.();
      const afterUnsubscribe = snapshots;
      invariant(await application.prepareQuit(), 'Preserved application vetoed Quit');
      const raw = chat.storage.value;
      conversation?.setDraft('blocked after consent');
      invariant(chat.storage.value === raw, 'Prepared application admitted a draft edit');
      try {
        await application.openChat();
        throw Error('Prepared application admitted a panel');
      } catch (error) {
        invariant(
          ApplicationError.is(error) && error.code === 'Unavailable',
          'Unsafe public error',
        );
      }
      const disposal = application.dispose();
      invariant(application.dispose() === disposal, 'Repeated disposal did not join');
      await disposal;
      const state = conversation?.getSnapshot(),
        writes = chat.storage.writes;
      chat.controls.receiveChat(chat.snapshot);
      invariant(snapshots === afterUnsubscribe, 'Callback ran after unsubscribe/disposal');
      invariant(conversation?.getSnapshot() === state, 'Late observation changed disposed state');
      invariant(chat.storage.writes === writes, 'Late observation wrote saved work');
      invariant(
        chat.controls.closed === chat.controls.observations,
        'IO observation was not closed',
      );
      invariant(application.getSnapshot().phase === 'disposed', 'Disposal did not complete');
      completed.push(mode);
    } finally {
      for (const off of unsubscribe) off?.();
      await application.dispose();
    }
  }
  return completed;
}
