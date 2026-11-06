import { createMoonbaseApplication } from '@moonbase/application';
import { createRoot } from 'react-dom/client';
import { ManagedRuntime } from 'effect';
import * as stylex from '@stylexjs/stylex';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import type { CommandInput, EditorClient } from '@moonbase/contracts/workspace';
import { Workbench } from '../src/index.ts';
import { configureMonacoWorkers } from '../src/workers.ts';
import { memoryWorkspace } from '@moonbase/application/testing/memory-workspace';
import '@moonbase/ui/reset.css';
import 'virtual:stylex:runtime';

configureMonacoWorkers();
const checkout = {
  hostId: 'memory-save-race',
  checkoutId: 'race',
  projectId: 'race',
  root: '/controlled/save-race',
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const memory = memoryWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B' } }]);
const runtime = ManagedRuntime.make(memory.layer),
  raw = makeEditorClient(runtime);
let entered!: () => void, release!: () => void;
const began = new Promise<void>((resolve) => {
    entered = resolve;
  }),
  wait = new Promise<void>((resolve) => {
    release = resolve;
  });
let holdB = false,
  savingB = Promise.resolve(false);
const requests: CommandInput<'saveFile'>[] = [];
const client: EditorClient = {
  ...raw,
  async command(name, input, options) {
    if (name === 'saveFile') {
      const request = input as CommandInput<'saveFile'>;
      requests.push(structuredClone(request));
      if (holdB && request.target.path === 'b.ts') {
        entered();
        await wait;
      }
    }
    return raw.command(name, input, options);
  },
};
let application = await createMoonbaseApplication({ editors: [{ client, clientId: 'save-race' }] }),
  editor = application.editors[0]!;
await editor.openCheckout(checkout.root);
for (const path of ['a.ts', 'b.ts']) {
  await editor.open({ checkout, path });
  editor.edit({ checkout, path }, 'CAPTURE ' + path);
}
await editor.open({ checkout, path: 'a.ts' });
await editor.flush();
const styles = stylex.create({ root: { height: '100dvh' } }),
  root = createRoot(document.getElementById('root')!);
const render = () =>
  root.render(
    <div {...stylex.props(styles.root)}>
      <Workbench key={editor.instanceId} controller={editor} checkout={checkout} />
    </div>,
  );
render();
window.saveRace = {
  get editor() {
    return editor;
  },
  checkout,
  memory,
  requests,
  async startB() {
    holdB = true;
    savingB = editor.save({ checkout, path: 'b.ts' });
    await began;
  },
  async releaseB() {
    release();
    await savingB;
  },
  load: () => raw.command('loadRecovery', { clientId: editor.clientId }),
  async restart() {
    await application.dispose();
    application = await createMoonbaseApplication({
      editors: [{ client: raw, clientId: 'save-race' }],
    });
    editor = application.editors[0]!;
    render();
  },
};
declare global {
  interface Window {
    saveRace: {
      readonly editor: typeof editor;
      checkout: typeof checkout;
      memory: typeof memory;
      requests: typeof requests;
      startB(): Promise<void>;
      releaseB(): Promise<void>;
      load(): ReturnType<typeof raw.command<'loadRecovery'>>;
      restart(): Promise<void>;
    };
  }
}
window.addEventListener(
  'pagehide',
  () => {
    release();
    void application.dispose().finally(() => runtime.dispose());
  },
  { once: true },
);
