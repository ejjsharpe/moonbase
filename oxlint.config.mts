import { base, effectNativeOff, effectNativeRules, node, web } from '@moonbase/config/oxlint';
import { defineConfig } from 'oxlint';

/** Production code, which D15's Effect-native rules cover. */
const production = ['{apps,packages}/*/src/**'];

/**
 * The edge files where production code may use what the Effect-native rules forbid: process roots,
 * platform adapters, the test hooks entry and React/DOM edges where a browser API is the boundary.
 * Each lifts only what it names, for its reason.
 */
const effectNativeEdges: { files: string[]; allow: string[]; reason: string }[] = [
  {
    files: ['apps/desktop/src/main/main.ts'],
    allow: ['makeRunMain'],
    reason: "Electron main's process root runs its one program (CL-24).",
  },
  {
    files: ['apps/daemon/src/daemon-process.ts'],
    allow: ['runMain'],
    reason: "The daemon process's root runs its one program on BunRuntime (CL-28).",
  },
  {
    files: ['apps/desktop/src/renderer/main.tsx'],
    allow: ['runPromise', 'runPromiseExit', 'runSync'],
    reason: "The renderer's root owns its one runtime and the runners it hands the views.",
  },
  {
    files: ['apps/desktop/src/main/test-hooks.ts'],
    allow: ['runPromiseExitWith'],
    reason:
      "The unpackaged test hook is Promise code; a request it proceeds with runs on main's fiber.",
  },
  {
    files: [
      'apps/desktop/src/renderer/shell/desktop-application.ts',
      'apps/desktop/src/renderer/chat/chat-header.tsx',
      'apps/desktop/src/renderer/chat/composer/composer.tsx',
      'apps/desktop/src/renderer/chat/transcript/transcript-actions.ts',
    ],
    allow: ['runner.runSync'],
    reason:
      "DOM event handlers, and an effect cancelling a transcript's actions, make synchronous service updates on the renderer root's runner.",
  },
  {
    files: ['packages/workbench/src/files-tree/use-drop-target.ts'],
    allow: ['setTimeout'],
    reason: "A drag's hover-to-expand delay and leave debounce are DOM drag timing.",
  },
  {
    files: ['packages/workbench/src/files-tree/use-entry-drag.ts'],
    allow: ['setTimeout'],
    reason: 'The drag image is removed once the browser has captured it, after dragstart.',
  },
  {
    files: ['packages/workbench/src/files-tree/use-follow-active-file.ts'],
    allow: ['setTimeout'],
    reason:
      "Following settles on the last of rapid active-file switches, in a React effect's cleanup.",
  },
  {
    files: ['packages/application/src/chat/chat-promises.ts'],
    allow: ['runPromiseExit', 'AbortController'],
    reason: 'Temporary: the Promise chat client, removed by #353.',
  },
];

export default defineConfig({
  ...base,
  ignorePatterns: ['**/dist/**', '**/release/**', '**/coverage/**'],
  overrides: [
    {
      ...node,
      files: [
        '**/*.config.{js,mjs,cjs,ts,mts,cts}',
        'scripts/**',
        'packages/config/**',
        '**/{test,tests,scripts}/**',
        'apps/desktop/src/*.{js,ts,mjs,cjs,mts,cts}',
        'packages/{workspace,chat-runtime,daemon-protocol,ssh}/**',
      ],
    },
    {
      ...web,
      files: ['**/*.tsx', 'apps/desktop/src/renderer/**', 'packages/{workbench,ui}/**'],
    },
    { files: production, plugins: [...base.plugins, 'promise'], rules: effectNativeRules() },
    // Exported test fakes and fixtures: test code that runs its own runtimes.
    { files: ['packages/application/src/testing/**'], rules: effectNativeOff },
    ...effectNativeEdges.map(({ files, allow }) => ({ files, rules: effectNativeRules(allow) })),
  ],
});
