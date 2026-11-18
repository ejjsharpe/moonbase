import {
  MoonbaseApplication,
  makeApplicationAtoms,
  type ChatHostOptions,
} from '@moonbase/application';
import { editorLayer } from '@moonbase/application/editor';
import { installTranscriptDemo } from './transcript.ts';
import { chatCapabilities } from './chat.ts';
import { createRoot } from 'react-dom/client';
import { createRef, StrictMode, useState } from 'react';
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { RegistryContext } from '@effect/atom-react';
import { WorkspaceService } from '@moonbase/contracts/services';
import type { WorkspaceError } from '@moonbase/contracts/workspace-errors';
import type { CommandInput, CommandOutput, WorkspaceCommand } from '@moonbase/contracts/workspace';
import { makeEditorActions, makeWorkbenchEditor } from '@moonbase/workbench';
import { DesktopShell, type DesktopShellHandle } from '../src/renderer/shell/desktop-shell.tsx';
import type { DesktopApplication } from '../src/renderer/shell/desktop-application.ts';
import { driveChat } from '@moonbase/application/testing/chat-fixture';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
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
const committed = {
  'README.md':
    '# Volatile demo\n\nTwo editors share a workspace, with independent buffers and recovery identities.\n',
  'src/example.ts': 'export function double(value: number) {\n  return value * 2;\n}\n',
};
// Each seed's files are committed, except the main checkout's edited welcome.ts.
const committedSeed = (target: typeof checkout, files: Record<string, string>) => ({
  checkout: target,
  files,
  head: { ...files },
});
const memory = fauxWorkspace([
  {
    checkout,
    files: {
      'welcome.ts': "// Moonbase editor module demo\nexport const greeting = 'Hello Moonbase';\n",
      ...committed,
      'ignored.txt': 'Hidden when Git-ignored files are filtered.\n',
    },
    head: { ...committed, 'welcome.ts': "export const greeting = 'Hello';\n" },
    index: { 'welcome.ts': "export const greeting = 'Hello staged';\n" },
    ignored: ['ignored.txt'],
  },
  committedSeed(
    { ...checkout, checkoutId: 'other', projectId: 'demo-other', root: '/demo/other' },
    { 'elsewhere.ts': 'export const other = true;\n' },
  ),
  committedSeed(
    { ...checkout, checkoutId: 'third', projectId: 'demo-third', root: '/demo/third' },
    { 'third.ts': 'export const third = true;\n' },
  ),
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
  committedSeed(
    {
      ...checkout,
      checkoutId: 'legend',
      root: '/demo/legend-list',
      vcs: 'git' as const,
      branch: 'feat/legend-list',
      worktree: 'linked',
    },
    { 'welcome.ts': "export const greeting = 'Hello from a worktree';\n" },
  ),
]);
// The demo's views share one atom registry; each editor and its application is a window's.
const registry = AtomRegistry.make();
/** One window's composition root: the editor over the shared memory workspace, and its chat. */
async function makeDemoWindow(clientId: string, chat: ChatHostOptions = {}) {
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      MoonbaseApplication.layer(chat),
      Layer.provideMerge(editorLayer({ clientId }), demoWorkspace),
    ),
  );
  const context = await runtime.context();
  const service = Context.get(context, MoonbaseApplication);
  await runtime.runPromise(service.start);
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  const application: DesktopApplication = {
    service,
    atoms: makeApplicationAtoms(service),
    run,
    runSync: (effect) => runtime.runSync(effect),
  };
  const editor = makeWorkbenchEditor(context, run);
  return {
    runtime,
    application,
    editor,
    actions: makeEditorActions(editor, registry),
    dispose: () => run(service.release).finally(() => runtime.dispose()),
  };
}
const workspace = Effect.runSync(
  Effect.map(WorkspaceService, (service) => service).pipe(Effect.provide(memory.layer)),
);
/**
 * The memory workspace's commands, as the browser tests drive them. The editors call through it,
 * so a test may wrap `command` to hold or answer one.
 */
const client = {
  command: <K extends WorkspaceCommand>(
    operation: K,
    input: CommandInput<K>,
    _options?: { signal?: AbortSignal },
  ) =>
    Effect.runPromise(
      (
        workspace[operation] as (input: CommandInput<K>) => Effect.Effect<CommandOutput<K>, unknown>
      )(input),
    ),
};
const demoWorkspace = Layer.succeed(
  WorkspaceService,
  new Proxy(workspace, {
    get: (target, name: string) =>
      name === 'watch' || name === 'watchRecovery'
        ? target[name]
        : (input: never) =>
            Effect.tryPromise({
              try: () => client.command(name as WorkspaceCommand, input),
              catch: (error) => error as WorkspaceError,
            }),
  }),
);
const chat = chatCapabilities(
  new URLSearchParams(location.search).has('local'),
  new URLSearchParams(location.search).has('activity'),
);
const transcriptDemo = new URLSearchParams(location.search).has('transcript')
  ? await installTranscriptDemo(chat)
  : null;
let failChat = new URLSearchParams(location.search).has('fail-chat');
const firstWindow = await makeDemoWindow(
    'demo-first',
    // `&hosts` names two hosts for the same demo chat, so Settings offers Use.
    new URLSearchParams(location.search).has('hosts')
      ? {
          chatTargets: ['This Mac', 'Studio'].map((label) => ({
            id: label.toLowerCase().replace(' ', '-'),
            label,
            acquire: Effect.sync(() => chat.dependencies),
          })),
        }
      : {
          chat: Effect.suspend(() => {
            if (failChat) return Effect.fail(Error('Controlled Chat initialization failure'));
            return Effect.succeed(
              new URLSearchParams(location.search).has('chat') ||
                new URLSearchParams(location.search).has('local')
                ? chat.dependencies
                : null,
            );
          }),
        },
  ),
  secondWindow = await makeDemoWindow('demo-second'),
  first = firstWindow.actions,
  second = secondWindow.actions;
const firstApplication = firstWindow.application.service;
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
  const checkout = first.getSnapshot().recovery.checkouts.find((target) => target.root === root);
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
          application={firstWindow.application}
          editor={firstWindow.editor}
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
            memory.failNext('closeTab', 'Demo recovery edit failed. Close was vetoed.')
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
            void secondWindow.dispose().catch((error: unknown) => setCleanupError(String(error)));
          }}>
          Dispose second editor
        </Button>
      </div>
      {cleanupError && <p role="alert">{cleanupError}</p>}
      <div {...stylex.props(styles.editors)}>
        <section aria-label="First editor" hidden={!visible} {...stylex.props(styles.editor)}>
          <DesktopShell
            ref={firstHandle}
            application={firstWindow.application}
            editor={firstWindow.editor}
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
            <DesktopShell application={secondWindow.application} editor={secondWindow.editor} />
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
  const services = (await firstWindow.application.run(firstApplication.chat.open))!;
  const opened = driveChat(firstWindow.runtime, services);
  await opened.start();
  await opened.select(chat.target);
  await opened.setTranscriptView({
    anchor: { key: 'entry:reading-179', offset: 0 },
    expanded: [],
  });
}
createRoot(document.getElementById('root')!).render(
  <RegistryContext.Provider value={registry}>
    {new URLSearchParams(location.search).has('strict') ? (
      <StrictMode>
        <Demo />
      </StrictMode>
    ) : (
      <Demo />
    )}
  </RegistryContext.Provider>,
);
/** The first window's application, as the browser tests read and drive it. */
const application = {
  service: firstApplication,
  /** The chat it shows now, as a test reads and drives it. */
  get chat() {
    const services = registry.get(firstWindow.application.atoms.chat);
    return services && driveChat(firstWindow.runtime, services);
  },
  getSnapshot: () => registry.get(firstWindow.application.atoms.snapshot),
  canUnload: () => firstWindow.runtime.runSync(firstApplication.canUnload),
  /** Holds the next chat target switch until the returned callback releases it. */
  holdNextSwitch() {
    const gate = Promise.withResolvers<void>();
    const select = firstApplication.chat.select;
    Object.assign(firstApplication.chat, {
      select: (id: string) => {
        Object.assign(firstApplication.chat, { select });
        return Effect.andThen(
          Effect.promise(() => gate.promise),
          select(id),
        );
      },
    });
    return gate.resolve;
  },
};
declare global {
  interface Window {
    demo: {
      first: typeof first;
      second: typeof second;
      checkout: typeof checkout;
      memory: typeof memory;
      workbench(): DesktopShellHandle;
      application: typeof application;
      chat: typeof chat;
      transcript: typeof transcriptDemo;
      retryChat(): void;
      selectCheckout(): Promise<string | null>;
      selectClipboardImports(target: CheckoutTarget): Promise<string[] | null>;
      selectDroppedImports(target: CheckoutTarget, files: File[]): Promise<string[]>;
      /** What the file menu copied and revealed; the demo never touches the OS clipboard. */
      copied: string[];
      revealed: string[];
      modelCount(): number;
      diffReady(): boolean;
      client: typeof client;
    };
  }
}
window.demo = {
  first,
  second,
  application,
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
};
window.addEventListener(
  'pagehide',
  () => {
    void Promise.allSettled([firstWindow.dispose(), secondWindow.dispose()]);
  },
  { once: true },
);
