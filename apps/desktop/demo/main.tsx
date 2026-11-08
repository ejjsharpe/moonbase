import { createMoonbaseApplication } from '@moonbase/application';
import { installTranscriptDemo } from './transcript.ts';
import { chatCapabilities } from './chat.ts';
import { createRoot } from 'react-dom/client';
import { createRef, StrictMode, useState } from 'react';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { DesktopShell, type DesktopShellHandle } from '../src/renderer/shell/workbench.tsx';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';
import { memoryWorkspace } from '@moonbase/application/testing/memory-workspace';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
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
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const memory = memoryWorkspace([
  {
    checkout,
    files: {
      'welcome.ts': "// Moonbase editor module demo\nexport const greeting = 'Hello Moonbase';\n",
      'README.md':
        '# Volatile demo\n\nTwo editors share a workspace, with independent buffers and recovery identities.\n',
      'src/example.ts': 'export function double(value: number) {\n  return value * 2;\n}\n',
      'ignored.txt': 'Hidden when Git-ignored files are filtered.\n',
    },
    head: { 'welcome.ts': "export const greeting = 'Hello';\n" },
    index: { 'welcome.ts': "export const greeting = 'Hello staged';\n" },
    ignored: ['ignored.txt'],
  },
  {
    checkout: { ...checkout, checkoutId: 'other', projectId: 'demo-other', root: '/demo/other' },
    files: { 'elsewhere.ts': 'export const other = true;\n' },
  },
  {
    checkout: { ...checkout, checkoutId: 'third', projectId: 'demo-third', root: '/demo/third' },
    files: { 'third.ts': 'export const third = true;\n' },
  },
  // A plain folder in no Git repository, until Initialize Git.
  {
    checkout: {
      hostId: 'memory-demo',
      checkoutId: 'notes',
      projectId: 'demo-notes',
      root: '/demo/notes',
      vcs: 'none',
    },
    files: { 'notes.md': '# Notes\n\nA folder without Git.\n' },
  },
  // The first demo chat without a project's folder, which Turn into project opens.
  {
    checkout: {
      hostId: 'memory-demo',
      checkoutId: 'own-chat',
      projectId: 'demo-own-chat',
      root: '/demo/chats/chat-1',
      vcs: 'none',
    },
    files: {},
  },
  {
    checkout: {
      ...checkout,
      checkoutId: 'legend',
      root: '/demo/legend-list',
      vcs: 'git' as const,
      branch: 'feat/legend-list',
      worktree: 'linked',
    },
    files: { 'welcome.ts': "export const greeting = 'Hello from a worktree';\n" },
  },
]);
// One demo composition root. Feature packages do not construct runtimes.
const runtime = ManagedRuntime.make(memory.layer),
  client = makeEditorClient(runtime);
const chat = chatCapabilities(
  new URLSearchParams(location.search).has('local'),
  new URLSearchParams(location.search).has('activity'),
);
const transcriptDemo = new URLSearchParams(location.search).has('transcript')
  ? await installTranscriptDemo(chat)
  : null;
let failChat = new URLSearchParams(location.search).has('fail-chat');
const firstApplication = await createMoonbaseApplication({
    editors: [{ client, clientId: 'demo-first' }],
    // `&hosts` names two hosts for the same demo chat, so Settings offers Use.
    ...(new URLSearchParams(location.search).has('hosts')
      ? {
          chatTargets: ['This Mac', 'Studio'].map((label) => ({
            id: label.toLowerCase().replace(' ', '-'),
            label,
            acquire: async () => chat.dependencies,
          })),
        }
      : {
          chat: async () => {
            if (failChat) throw Error('Controlled Chat initialization failure');
            return new URLSearchParams(location.search).has('chat') ||
              new URLSearchParams(location.search).has('local')
              ? chat.dependencies
              : null;
          },
        }),
  }),
  secondApplication = await createMoonbaseApplication({
    editors: [{ client, clientId: 'demo-second' }],
  }),
  first = firstApplication.editors[0]!,
  second = secondApplication.editors[0]!;
const firstHandle = createRef<DesktopShellHandle>();
await Promise.all(
  [first, second].map(async (editor) => {
    await editor.openCheckout(checkout.root);
    await editor.open({ checkout, path: 'welcome.ts' }, { intent: 'keep' });
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
// Like main, a project checkout's chat worktree is a new linked worktree beside it, which then
// lists in the project's worktree switcher; other demo folders only record the request.
async function createChatWorktree(root: string, branch: string) {
  const checkout = firstApplication.editors[0]
    ?.getSnapshot()
    ?.recovery.checkouts.find((target) => target.root === root);
  if (!checkout) return chat.createWorktree(root, branch);
  chat.worktrees.push(`${root} ${branch}`);
  const created = await client.command('createWorktree', {
    checkout,
    base: checkout.vcs === 'git' ? checkout.branch : 'HEAD',
    branch,
    location: `${root}-worktrees/${branch.replaceAll('/', '-')}`,
  });
  return created.root;
}
function Demo() {
  const [visible, setVisible] = useState(true),
    [disposed, setDisposed] = useState(false),
    [cleanupError, setCleanupError] = useState('');
  if (new URLSearchParams(location.search).has('design'))
    return (
      <main {...stylex.props(workbench.document, styles.app)}>
        <DesktopShell
          application={firstApplication}
          transcriptNative={transcriptDemo ? () => transcriptDemo.native : undefined}
          chooseChatFolder={async () => '/demo/moonbase'}
          recentChatFolders={async () =>
            // `?folders` lists enough recent folders for the menu to offer its filter.
            new URLSearchParams(location.search).has('folders')
              ? [
                  'notes',
                  'game-engine',
                  'dotfiles',
                  'blog',
                  'scratch',
                  'api',
                  'infra',
                  'design',
                  'tools',
                ].map((name) => `/Users/demo/${name}`)
              : ['/Users/demo/notes', '/demo/moonbase']
          }
          createChatWorktree={createChatWorktree}
          turnChatIntoProject={(conversationId) => chat.turnIntoProject(conversationId)}
          selectCheckout={() => window.demo.selectCheckout()}
          selectClipboardImports={(checkout) => window.demo.selectClipboardImports(checkout)}
          copyPaths={async (target, paths, relative) => {
            window.demo.copied.push(
              paths.map((path) => (relative ? path : `${target.root}/${path}`)).join('\n'),
            );
          }}
          revealPath={async (checkout, path) => {
            window.demo.revealed.push(`${checkout.root}/${path}`);
          }}
          selectDroppedImports={(checkout, files) =>
            window.demo.selectDroppedImports(checkout, files)
          }
        />
      </main>
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
          <DesktopShell
            ref={firstHandle}
            application={firstApplication}
            transcriptNative={transcriptDemo ? () => transcriptDemo.native : undefined}
            selectCheckout={() => window.demo.selectCheckout()}
            selectClipboardImports={(checkout) => window.demo.selectClipboardImports(checkout)}
            copyPaths={async (target, paths, relative) => {
              window.demo.copied.push(
                paths.map((path) => (relative ? path : `${target.root}/${path}`)).join('\n'),
              );
            }}
            revealPath={async (checkout, path) => {
              window.demo.revealed.push(`${checkout.root}/${path}`);
            }}
            selectDroppedImports={(checkout, files) =>
              window.demo.selectDroppedImports(checkout, files)
            }
          />
        </section>
        {!disposed && (
          <section aria-label="Second editor" {...stylex.props(styles.editor, styles.second)}>
            <DesktopShell application={secondApplication} />
          </section>
        )}
      </div>
    </main>
  );
}
// `&long` or `&long=<count>` reads a long conversation (2,000 entries by default).
const longTranscript = new URLSearchParams(location.search).get('long');
if (transcriptDemo && longTranscript !== null)
  await transcriptDemo.long(Number(longTranscript) || undefined);
if (transcriptDemo && new URLSearchParams(location.search).has('reading')) {
  await firstApplication.chat!.start();
  await firstApplication.chat!.select(chat.target);
  firstApplication.chat!.setTranscriptView({
    anchor: { key: 'entry:reading-179', offset: 0 },
    expanded: [],
  });
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
      workbench(): DesktopShellHandle;
      application: typeof firstApplication;
      chat: typeof chat;
      transcript: typeof transcriptDemo;
      retryChat(): void;
      selectCheckout(): Promise<string | null>;
      selectClipboardImports(target: CheckoutTarget): Promise<string[]>;
      selectDroppedImports(target: CheckoutTarget, files: File[]): Promise<string[]>;
      /** What the file menu copied and revealed; the demo never touches the OS clipboard. */
      copied: string[];
      revealed: string[];
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
  chat,
  transcript: transcriptDemo,
  retryChat: () => {
    failChat = false;
  },
  selectCheckout: async () => null,
  selectClipboardImports: async () => [],
  selectDroppedImports: async () => [],
  copied: [],
  revealed: [],
  checkout,
  memory,
  workbench: () => firstHandle.current!,
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
