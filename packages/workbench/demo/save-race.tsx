import { createRoot } from 'react-dom/client';
import { Effect, ManagedRuntime } from 'effect';
import * as stylex from '@stylexjs/stylex';
import { RegistryContext } from '@effect/atom-react';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import type { CommandInput, CommandOutput } from '@moonbase/contracts/workspace';
import { Workbench } from '../src/index.ts';
import {
  buildDemoEditor,
  makeDemoClient,
  makeDemoRegistry,
  makeDemoWorkspace,
  type DemoClient,
} from './demo-editors.ts';
import { configureMonacoWorkers } from '../src/workers.ts';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import '@moonbase/ui/reset.css';
import '@moonbase/ui/fonts.css';
import 'virtual:stylex:runtime';

configureMonacoWorkers();
const checkout = {
  hostId: 'memory-save-race',
  checkoutId: 'race',
  projectId: 'race',
  root: '/controlled/save-race',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const files = { 'a.ts': 'A', 'b.ts': 'B' };
const memory = fauxWorkspace([{ checkout, files, head: { ...files } }]);
const runtime = ManagedRuntime.make(memory.layer);
const base = await runtime.runPromise(Effect.service(WorkspaceService)),
  raw = makeDemoClient(runtime, base),
  registry = makeDemoRegistry();
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
const client: DemoClient = {
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
let built = await buildDemoEditor(
    runtime,
    registry,
    makeDemoWorkspace(base, () => client),
    'save-race',
  ),
  editor = built.handle;
await editor.openCheckout(checkout.root);
for (const path of ['a.ts', 'b.ts']) {
  await editor.open({ checkout, path });
  await editor.edit({ checkout, path }, 'CAPTURE ' + path);
}
await editor.open({ checkout, path: 'a.ts' });
await editor.flush();
// Each restart remounts the workbench on the new editor.
let restarts = 0;
const styles = stylex.create({ root: { height: '100dvh' } }),
  root = createRoot(document.getElementById('root')!);
const render = () =>
  root.render(
    <div {...stylex.props(styles.root)}>
      <RegistryContext.Provider value={registry}>
        <Workbench key={restarts} editor={built.editor} checkout={checkout} />
      </RegistryContext.Provider>
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
    await editor.release();
    built = await buildDemoEditor(
      runtime,
      registry,
      makeDemoWorkspace(base, () => raw),
      'save-race',
    );
    editor = built.handle;
    restarts++;
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
      load(): Promise<CommandOutput<'loadRecovery'>>;
      restart(): Promise<void>;
    };
  }
}
window.addEventListener(
  'pagehide',
  () => {
    release();
    void editor.release().finally(() => runtime.dispose());
  },
  { once: true },
);
