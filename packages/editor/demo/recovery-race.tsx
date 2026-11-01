import { createRoot } from 'react-dom/client';
import { ManagedRuntime } from 'effect';
import { ApplicationError, type CommandInput } from '@moonbase/application/client';
import { makeEditorClient } from '@moonbase/application/runtime-client';
import { EditorWorkbench, createEditor } from '../src/index.ts';
import { configureMonacoWorkers } from '../src/workers.ts';
import { memoryWorkspace } from '../src/memory.ts';
import '@moonbase/ui/reset.css';
import 'virtual:stylex:runtime';

configureMonacoWorkers();
const parameters = new URLSearchParams(location.search),
  dirtyArea = parameters.get('dirty'),
  missingArea = parameters.get('missing');
const alpha = {
  hostId: 'memory',
  checkoutId: 'alpha',
  projectId: 'race',
  root: '/race/alpha',
  branch: 'main',
};
const beta = { ...alpha, checkoutId: 'beta', root: '/race/beta' };
const memory = memoryWorkspace(
  [alpha, beta].map((checkout) => {
    const files: Record<string, string> =
      checkout === alpha && missingArea
        ? { 'b.ts': 'current B' }
        : { 'a.ts': 'current A', 'b.ts': 'current B' };
    return {
      checkout,
      files,
      ...(dirtyArea || missingArea
        ? { head: { 'a.ts': 'HEAD A' }, index: { 'a.ts': 'INDEX A' } }
        : {}),
    };
  }),
);
const runtime = ManagedRuntime.make(memory.layer),
  client = makeEditorClient(runtime);
const seed = createEditor({ client, clientId: 'recovery-race' });
await seed.load();
await seed.openCheckout(beta.root);
await seed.open({ checkout: beta, path: 'a.ts' });
if (parameters.has('both')) await seed.open({ checkout: beta, path: 'b.ts' });
await seed.openCheckout(alpha.root);
const comparisonArea = missingArea ?? dirtyArea;
await seed.open(
  { checkout: alpha, path: 'a.ts' },
  { view: comparisonArea === 'staged' || comparisonArea === 'unstaged' ? comparisonArea : 'file' },
);
if (dirtyArea) seed.edit({ checkout: alpha, path: 'a.ts' }, 'restored dirty A');
if (!missingArea) await seed.open({ checkout: alpha, path: 'b.ts' });
await seed.flush();
seed.dispose();
let loseFinal = false,
  failStatus = false;
let hold = false,
  waiting = false,
  release!: () => void;
let wait = new Promise<void>((resolve) => {
  release = resolve;
});
let holdCopyPreflight = false,
  holdCopyRead = false,
  copyPhase = '';
let releaseCopyPreflight = () => {},
  releaseCopyRead = () => {};
let copyPreflight = Promise.resolve(),
  copyRead = Promise.resolve(),
  copying = Promise.resolve();
const editor = createEditor({
  clientId: 'recovery-race',
  client: {
    ...client,
    async command(name, input, options) {
      if (name === 'persistRecovery' && holdCopyPreflight) {
        holdCopyPreflight = false;
        const receipt = await client.command(name, input, options);
        copyPhase = 'preflight';
        await copyPreflight;
        return receipt;
      }
      if (
        name === 'readFile' &&
        (input as CommandInput<'readFile'>).path === 'copy.ts' &&
        holdCopyRead
      ) {
        holdCopyRead = false;
        const disk = await client.command(name, input, options);
        copyPhase = 'read';
        await copyRead;
        return disk;
      }
      if (hold && name === 'persistRecovery') {
        waiting = true;
        await wait;
      }
      if (
        loseFinal &&
        name === 'persistRecovery' &&
        !(input as CommandInput<'persistRecovery'>).state.views.alpha.openFiles.includes('b.ts')
      ) {
        loseFinal = false;
        failStatus = true;
        await client.command(name, input, options);
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'Controlled lost final close response',
        });
      }
      if (failStatus && name === 'getRecoveryPublication') {
        failStatus = false;
        throw new ApplicationError({ code: 'Unavailable', message: 'Controlled status outage' });
      }
      return client.command(name, input, options);
    },
  },
});
await editor.load();
createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh' }}>
    <EditorWorkbench controller={editor} />
  </div>,
);
declare global {
  interface Window {
    recoveryRace: {
      editor: typeof editor;
      hold(): void;
      release(): void;
      loseFinalResponse(): void;
      recreateWorking(): Promise<void>;
      readonly waiting: boolean;
      copy: {
        start(): void;
        releasePreflight(): void;
        releaseRead(): void;
        finish(): Promise<void>;
        readonly phase: string;
      };
      load(): ReturnType<typeof client.command<'loadRecovery'>>;
    };
  }
}
window.recoveryRace = {
  editor,
  hold() {
    hold = true;
    waiting = false;
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
  },
  release() {
    hold = false;
    release();
  },
  loseFinalResponse() {
    loseFinal = true;
  },
  get waiting() {
    return waiting;
  },
  async recreateWorking() {
    await client.command('mutate', {
      checkout: alpha,
      clientId: 'fixture-recreator',
      id: crypto.randomUUID(),
      kind: 'create-file',
      sources: [],
      destination: 'a.ts',
      text: 'RECREATED WORKING FILE',
    });
    await editor.refresh(alpha);
  },
  copy: {
    start() {
      holdCopyPreflight = true;
      holdCopyRead = true;
      copyPhase = '';
      copyPreflight = new Promise<void>((resolve) => {
        releaseCopyPreflight = resolve;
      });
      copyRead = new Promise<void>((resolve) => {
        releaseCopyRead = resolve;
      });
      copying = editor
        .inspect(alpha, ['a.ts'])
        .then((sources) =>
          editor.mutate({ checkout: alpha, sources, kind: 'copy', destination: 'copy.ts' }),
        )
        .then(() => {
          copyPhase = 'done';
        });
    },
    releasePreflight() {
      releaseCopyPreflight();
    },
    releaseRead() {
      releaseCopyRead();
    },
    finish() {
      return copying;
    },
    get phase() {
      return copyPhase;
    },
  },
  load: () => client.command('loadRecovery', { clientId: editor.clientId }),
};
window.addEventListener(
  'pagehide',
  () => {
    editor.dispose();
    void runtime.dispose();
  },
  { once: true },
);
