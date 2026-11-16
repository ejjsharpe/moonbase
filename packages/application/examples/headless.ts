import { ManagedRuntime } from 'effect';
import { createMoonbaseApplication } from '@moonbase/application';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { fauxChat } from '@moonbase/application/testing/faux-chat';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import { ApplicationError } from '@moonbase/contracts/errors';

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

// An in-memory workspace for the commands exercised below.
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
  const runtime = ManagedRuntime.make(
    fauxWorkspace([{ checkout, files: { 'example.txt': 'original' } }]).layer,
  );
  return {
    client: makeEditorClient(runtime),
    target: { checkout, path: 'example.txt' },
    dispose: () => runtime.dispose(),
  };
}

/** Direct public API consumer; the same code runs from source and emitted browser-targeted JS. */
export async function checkHeadlessApplication() {
  const completed: string[] = [];
  for (const mode of ['editor', 'chat', 'combined']) {
    const editor = editorCapabilities(),
      chat = fauxChat();
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
      await editor.dispose();
    }
  }
  return completed;
}
