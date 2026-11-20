import { createRoot } from 'react-dom/client';
import { Tabs } from '@base-ui/react/tabs';
import * as stylex from '@stylexjs/stylex';
import { RegistryContext, useAtomValue } from '@effect/atom-react';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { Effect, ManagedRuntime } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import type { CommandOutput } from '@moonbase/contracts/workspace';
import { WorkspaceUnavailableError } from '@moonbase/contracts/workspace-host-errors';
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
const parameters = new URLSearchParams(location.search),
  dirtyArea = parameters.get('dirty'),
  missingArea = parameters.get('missing');
const alpha = {
  hostId: 'memory',
  checkoutId: 'alpha',
  projectId: 'race',
  root: '/race/alpha',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const beta = { ...alpha, checkoutId: 'beta', root: '/race/beta' };
const memory = fauxWorkspace(
  [alpha, beta].map((checkout) => {
    const files: Record<string, string> =
      checkout === alpha && missingArea
        ? { 'b.ts': 'current B' }
        : { 'a.ts': 'current A', 'b.ts': 'current B' };
    return {
      checkout,
      files,
      // Committed files are clean, except a.ts when a test needs Git baselines for it.
      ...(dirtyArea || missingArea
        ? { head: { 'a.ts': 'HEAD A', 'b.ts': 'current B' }, index: { 'a.ts': 'INDEX A' } }
        : { head: { ...files } }),
    };
  }),
);
const runtime = ManagedRuntime.make(memory.layer);
const base = await runtime.runPromise(Effect.service(WorkspaceService)),
  client = makeDemoClient(runtime, base),
  registry = makeDemoRegistry();
const seed = (
  await buildDemoEditor(
    runtime,
    registry,
    makeDemoWorkspace(base, () => client),
    'recovery-race',
  )
).handle;
await seed.openCheckout(beta.root);
await seed.open({ checkout: beta, path: 'a.ts' });
if (parameters.has('both')) await seed.open({ checkout: beta, path: 'b.ts' });
await seed.openCheckout(alpha.root);
const comparisonArea = missingArea ?? dirtyArea;
await seed.open(
  { checkout: alpha, path: 'a.ts' },
  { view: comparisonArea === 'staged' || comparisonArea === 'unstaged' ? comparisonArea : 'file' },
);
if (dirtyArea) await seed.edit({ checkout: alpha, path: 'a.ts' }, 'restored dirty A');
if (!missingArea) await seed.open({ checkout: alpha, path: 'b.ts' });
await seed.flush();
await seed.release();
const edits = new Set(['openTab', 'closeTab', 'updateDraft', 'updateLayout']);
let loseFinal = false;
let hold = false,
  waiting = false,
  release!: () => void;
let wait = new Promise<void>((resolve) => {
  release = resolve;
});
let holdCopyPreflight = false,
  copyPhase = '';
let releaseCopyPreflight = () => {};
let copyPreflight = Promise.resolve(),
  copying = Promise.resolve();
const racing: DemoClient = {
  async command(name, input, options) {
    if (edits.has(name) && holdCopyPreflight) {
      holdCopyPreflight = false;
      const receipt = await client.command(name, input, options);
      copyPhase = 'preflight';
      await copyPreflight;
      return receipt;
    }
    if (hold && edits.has(name)) {
      waiting = true;
      await wait;
    }
    // The close commits in the store, and its reply is lost.
    if (loseFinal && name === 'closeTab') {
      loseFinal = false;
      await client.command(name, input, options);
      throw new WorkspaceUnavailableError({ cause: 'failed' });
    }
    return client.command(name, input, options);
  },
};
const built = await buildDemoEditor(
    runtime,
    registry,
    makeDemoWorkspace(base, () => racing),
    'recovery-race',
  ),
  editor = built.handle;
function RecoveryRace() {
  const recovery = useAtomValue(built.editor.atoms.views.checkouts);
  const checkout = recovery.checkouts.find(
    (item) => item.checkoutId === recovery.selectedCheckoutId,
  );
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Tabs.Root
        value={checkout?.checkoutId}
        onValueChange={(id) => {
          const target = recovery.checkouts.find((item) => item.checkoutId === id);
          if (target) void editor.selectCheckout(target).catch(editor.report);
        }}>
        <Tabs.List aria-label="Demo projects" {...stylex.props(workbench.projectTabs)}>
          {recovery.checkouts
            .filter((item) => recovery.openCheckoutIds.includes(item.checkoutId))
            .map((item) => (
              <Tabs.Tab
                key={item.checkoutId}
                value={item.checkoutId}
                {...stylex.props(controls.button)}>
                {item.checkoutId} · {item.vcs === 'git' ? item.branch : 'folder'}
              </Tabs.Tab>
            ))}
        </Tabs.List>
      </Tabs.Root>
      <Workbench editor={built.editor} checkout={checkout} />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <RegistryContext.Provider value={registry}>
    <RecoveryRace />
  </RegistryContext.Provider>,
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
        finish(): Promise<void>;
        readonly phase: string;
      };
      load(): Promise<CommandOutput<'loadRecovery'>>;
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
      copyPhase = '';
      copyPreflight = new Promise<void>((resolve) => {
        releaseCopyPreflight = resolve;
      });
      // The copy's own flush has an edit to send, which the hold catches.
      void editor.edit({ checkout: alpha, path: 'a.ts' }, 'source before the copy');
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
    void editor.release().finally(() => runtime.dispose());
  },
  { once: true },
);
