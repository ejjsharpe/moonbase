import { createMoonbaseApplication } from '@moonbase/application';
import { createRoot } from 'react-dom/client';
import { createRef, StrictMode, useState } from 'react';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { Workbench, type WorkbenchHandle } from '../src/index.ts';
import { configureMonacoWorkers } from '../src/workers.ts';
import { memoryWorkspace } from '@moonbase/application/testing/memory-workspace';
import * as monaco from 'monaco-editor';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { colors, space } from '@moonbase/ui/tokens.stylex';
import '@moonbase/ui/reset.css';
import '@moonbase/ui/fonts.css';
import 'virtual:stylex:runtime';

configureMonacoWorkers();
const checkout = {
  hostId: 'memory-demo',
  checkoutId: 'sample',
  projectId: 'demo',
  root: '/demo/moonbase',
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const remoteCheckout = { ...checkout, hostId: 'remote-memory', root: '/demo/remote' };
const secondCheckout = new URLSearchParams(location.search).has('remote')
  ? remoteCheckout
  : checkout;
const committed = {
  'README.md':
    '# Volatile demo\n\nTwo editors share a workspace, with independent buffers and recovery identities.\n',
  'src/example.ts': 'export function double(value: number) {\n  return value * 2;\n}\n',
};
const memory = memoryWorkspace([
  {
    checkout,
    files: {
      'welcome.ts': "// Moonbase editor module demo\nexport const greeting = 'Hello Moonbase';\n",
      ...committed,
      'src/ignored.ts': '// Git-ignored entries remain visible.\n',
      'ignored.txt': 'Hidden when Git-ignored files are filtered.\n',
    },
    head: { ...committed, 'welcome.ts': "export const greeting = 'Hello';\n" },
    index: { 'welcome.ts': "export const greeting = 'Hello staged';\n" },
    ignored: ['ignored.txt', 'src/ignored.ts'],
  },
  {
    checkout: { ...checkout, checkoutId: 'other', root: '/demo/other' },
    files: { 'elsewhere.ts': 'export const other = true;\n' },
    head: { 'elsewhere.ts': 'export const other = true;\n' },
  },
  {
    checkout: remoteCheckout,
    files: { 'welcome.ts': '// Controlled remote fixture\n', 'README.md': '# Remote fixture\n' },
    head: { 'welcome.ts': '// Controlled remote fixture\n', 'README.md': '# Remote fixture\n' },
  },
]);
// One demo composition root. Feature packages do not construct runtimes.
const runtime = ManagedRuntime.make(memory.layer),
  client = makeEditorClient(runtime);
const firstApplication = await createMoonbaseApplication({
    editors: [{ client, clientId: 'demo-first' }],
  }),
  secondApplication = await createMoonbaseApplication({
    editors: [{ client, clientId: 'demo-second' }],
  }),
  first = firstApplication.editors[0]!,
  second = secondApplication.editors[0]!;
const firstHandle = createRef<WorkbenchHandle>();
await Promise.all(
  [first, second].map(async (editor) => {
    const target = editor === second ? secondCheckout : checkout;
    await editor.openCheckout(target.root);
    await editor.open({ checkout: target, path: 'welcome.ts' }, { intent: 'keep' });
  }),
);
const styles = stylex.create({
  app: { height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  tools: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
    padding: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
  },
  editors: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) minmax(0, 1fr)',
      '@media (max-width: 1100px)': 'minmax(0, 1fr)',
    },
  },
  editor: {
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.border,
  },
  second: { '@media (max-width: 1100px)': { display: 'none' } },
});
function Demo() {
  const [visible, setVisible] = useState(true),
    [disposed, setDisposed] = useState(false),
    [cleanupError, setCleanupError] = useState(''),
    [sidebarHidden, setSidebarHidden] = useState(() =>
      new URLSearchParams(location.search).has('sidebar-hidden'),
    );
  return (
    <main {...stylex.props(workbench.document, styles.app)}>
      <div {...stylex.props(styles.tools)}>
        <span>Volatile in-memory demo</span>
        <Button
          {...stylex.props(controls.button)}
          onClick={() =>
            memory.externalWrite(
              { checkout, path: 'welcome.ts' },
              "// External writer\nexport const greeting = 'Changed externally';\n",
            )
          }>
          External change
        </Button>
        <Button
          {...stylex.props(controls.button)}
          onClick={() => memory.failNext('saveFile', 'Demo Save failed. Your edits are retained.')}>
          Fail next Save
        </Button>
        <Button
          {...stylex.props(controls.button)}
          onClick={() =>
            memory.failNext(
              'persistRecovery',
              'Demo recovery publication failed. Close was vetoed.',
            )
          }>
          Fail next recovery
        </Button>
        <Button {...stylex.props(controls.button)} onClick={() => setVisible((value) => !value)}>
          {visible ? 'Hide' : 'Show'} first editor
        </Button>
        <Button
          {...stylex.props(controls.button)}
          onClick={() => {
            setDisposed(true);
            void secondApplication.dispose().catch((error) => setCleanupError(String(error)));
          }}>
          Dispose second editor
        </Button>
      </div>
      {cleanupError && <p role="alert">{cleanupError}</p>}
      <div {...stylex.props(styles.editors)}>
        <section aria-label="First editor" hidden={!visible} {...stylex.props(styles.editor)}>
          <Workbench
            ref={firstHandle}
            controller={first}
            checkout={checkout}
            visible={visible}
            sidebarHidden={sidebarHidden}
            onShowSidebar={() => setSidebarHidden(false)}
            renderLayout={
              new URLSearchParams(location.search).has('editor-only')
                ? ({ editor }) => editor
                : undefined
            }
            selectNativeImports={() => window.demo.selectNativeImports()}
            copyPaths={async (target, paths, relative) => {
              window.demo.copied.push(
                paths.map((path) => (relative ? path : `${target.root}/${path}`)).join('\n'),
              );
            }}
            revealPath={async (target, path) => {
              window.demo.revealed.push(`${target.root}/${path}`);
            }}
            mentionInChat={(_target, paths) => window.demo.mentioned.push(paths)}
            selectClipboardImports={
              new URLSearchParams(location.search).has('clipboard')
                ? () => window.demo.selectClipboardImports()
                : undefined
            }
          />
        </section>
        {!disposed && (
          <section aria-label="Second editor" {...stylex.props(styles.editor, styles.second)}>
            <Workbench controller={second} checkout={secondCheckout} />
          </section>
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('strict') ? (
    <StrictMode>
      <Demo />
    </StrictMode>
  ) : (
    <Demo />
  ),
);
declare global {
  interface Window {
    demo: {
      first: typeof first;
      second: typeof second;
      checkout: typeof checkout;
      memory: typeof memory;
      workbench(): WorkbenchHandle;
      application: typeof firstApplication;
      selectNativeImports(): Promise<string[]>;
      selectClipboardImports(): Promise<string[]>;
      /** What the first editor's menu copied, revealed and mentioned in chat. */
      copied: string[];
      revealed: string[];
      mentioned: string[][];
      modelCount(): number;
      diffReady(): boolean;
      client: typeof client;
      runtime: typeof runtime;
    };
  }
}
window.demo = {
  first,
  second,
  application: firstApplication,
  checkout,
  memory,
  workbench: () => firstHandle.current!,
  selectNativeImports: async () => [],
  selectClipboardImports: async () => [],
  copied: [],
  revealed: [],
  mentioned: [],
  modelCount: () => monaco.editor.getModels().length,
  diffReady: () =>
    monaco.editor.getDiffEditors().every((editor) => editor.getLineChanges() !== null),
  client,
  runtime,
};
window.addEventListener(
  'pagehide',
  () => {
    void Promise.allSettled([firstApplication.dispose(), secondApplication.dispose()]).finally(() =>
      runtime.dispose(),
    );
  },
  { once: true },
);
