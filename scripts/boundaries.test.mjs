import assert from 'node:assert/strict';
import { checkBoundaries, imports, isPrivilegedDesktopInput } from './boundaries.mjs';

const packages = new Map([
  [
    '@moonbase/application',
    {
      directory: 'packages/application',
      exports: {
        '.': './src/index.ts',
        './runtime/clients': './src/index.ts',
        './editor': './src/editor.ts',
        './chat': './src/chat.ts',
      },
    },
  ],
  [
    '@moonbase/contracts',
    {
      directory: 'packages/contracts',
      exports: { '.': './src/index.ts', './services': './src/services.ts' },
    },
  ],
  [
    '@moonbase/chat-runtime',
    { directory: 'packages/chat-runtime', exports: { '.': './src/index.ts' } },
  ],
  [
    '@moonbase/daemon-protocol',
    { directory: 'packages/daemon-protocol', exports: { './remote': './src/remote.ts' } },
  ],
  ['@moonbase/ssh', { directory: 'packages/ssh', exports: { '.': './src/index.ts' } }],
  ['@moonbase/effect', { directory: 'packages/effect', exports: { '.': './src/index.ts' } }],
]);
function check(sources) {
  return checkBoundaries({
    packages,
    files: new Map(Object.entries(sources).map(([path, source]) => [path, imports(source, path)])),
  });
}
assert.deepEqual(check({ 'packages/application/src/index.ts': 'export const value = 1;' }), []);
assert.deepEqual(
  check({ 'packages/application/src/index.ts': "import 'effect/Schema'; import 'lru-cache';" }),
  [],
);
assert(
  check({ 'packages/application/src/index.ts': "import 'lru-cache-extra';" }).some((error) =>
    error.includes('portable external dependency is not allowlisted'),
  ),
);
for (const source of [
  "import 'node:fs';",
  "import type { ReactNode } from 'react';",
  "await import('electron');",
  "import backend = require('node:fs');",
  "const backend = require('node:fs');",
  "type Backend = import('@moonbase/chat-runtime').Backend;",
]) {
  assert(check({ 'packages/application/src/index.ts': source }).length, source);
}
assert(
  check({ 'packages/application/src/index.ts': "import '@moonbase/contracts/src/private';" }).some(
    (error) => error.includes('public package export'),
  ),
);
for (const specifier of ['@moonbase/chat', '@moonbase/editor', '@moonbase/application/client'])
  assert(
    check({ 'apps/desktop/src/main/main.ts': `import '${specifier}';` }).some((error) =>
      error.includes('public package export'),
    ),
  );
assert(
  check({
    'packages/workbench/src/index.ts': "import type {} from '@moonbase/chat-runtime';",
  }).some((error) => error.includes('presentation depends on infrastructure')),
);
for (const source of [
  "import type {} from 'node:fs';",
  "type Backend = import('fs/promises').Backend;",
  "await import('electron');",
  "import type {} from '@effect/platform-node';",
  "import type {} from '@moonbase/desktop';",
  "import type {} from '@moonbase/contracts/services';",
  "import type {} from '@moonbase/application/runtime/clients';",
])
  assert(check({ 'packages/workbench/src/index.ts': source }).length, source);
assert(
  check({
    'packages/workbench/src/index.ts': "import type {} from '../demo/chat.ts';",
    'packages/workbench/demo/chat.ts': '',
  }).some((error) => error.includes('demo/test capability')),
);
for (const specifier of [
  '@moonbase/application',
  '@moonbase/application/chat',
  '@moonbase/contracts/chat',
  '@moonbase/contracts/connection',
  '@moonbase/contracts/host-schema',
])
  assert(
    check({ 'packages/workbench/src/index.ts': `import type {} from '${specifier}';` }).some(
      (error) => error.includes('only editor capabilities'),
    ),
  );
assert.deepEqual(
  check({
    'packages/workbench/src/index.ts': "import type {} from '@moonbase/application/editor';",
  }),
  [],
);
assert(
  check({
    'packages/application/src/index.ts': "import '../../contracts/src/index.ts';",
    'packages/contracts/src/index.ts': '',
  }).some((error) => error.includes('cross-package source')),
);
assert(
  check({
    'packages/application/src/index.ts': "import './other.ts';",
    'packages/application/src/other.ts': "import './index.ts';",
  }).some((error) => error.includes('runtime source cycle')),
);
assert(
  check({
    'packages/application/src/index.ts': "import type {} from '@moonbase/contracts';",
    'packages/contracts/src/index.ts': "import type {} from '@moonbase/application';",
  }).some((error) => error.includes('package cycle')),
);
assert.deepEqual(
  check({
    'packages/daemon-protocol/examples/remote.ts':
      "import '@moonbase/application/runtime/clients';",
  }),
  [],
);
assert(
  check({
    'packages/daemon-protocol/src/remote.ts': "import './socket-client.ts';",
    'packages/daemon-protocol/src/socket-client.ts': "import './protocol.ts';",
    'packages/daemon-protocol/src/protocol.ts': "import '../examples/remote.ts';",
    'packages/daemon-protocol/examples/remote.ts': "import '@moonbase/application';",
    'packages/application/src/index.ts': '',
  }).some((error) => error.includes('reusable export reaches process root')),
);
assert(
  check({
    'packages/chat-runtime/src/index.ts': "import './resources.ts';",
    'packages/chat-runtime/src/resources.ts': "import './commands.ts';",
    'packages/chat-runtime/src/commands.ts': "import type {} from '@moonbase/application';",
    'packages/application/src/index.ts': '',
  }).some((error) => error.includes('reusable infrastructure')),
);
for (const [path, specifier] of [
  ['packages/daemon-protocol/src/remote.ts', '@moonbase/chat-runtime'],
  ['packages/chat-runtime/src/index.ts', '@moonbase/daemon-protocol/remote'],
  ['packages/ssh/src/index.ts', '@moonbase/daemon-protocol/remote'],
  ['packages/daemon-protocol/src/remote.ts', '@moonbase/ssh'],
])
  assert(
    check({ [path]: `import type {} from '${specifier}';` }).some((error) =>
      error.includes('infrastructure imports another implementation'),
    ),
    `${path} -> ${specifier}`,
  );
assert(
  check({
    'packages/contracts/src/index.ts': "import '@moonbase/effect';",
    'packages/effect/src/application-error.ts': '',
  }).some((error) => error.includes('contracts depends on executable')),
);
console.log(
  'Boundary negative fixtures passed: platform/type/dynamic/deep imports, cycles and hidden process-root back edges.',
);

for (const entry of ['main/main.ts', 'main/chat/session.ts', 'main/future-owner.ts'])
  assert(isPrivilegedDesktopInput(`/checkout/apps/desktop/src/${entry}`), entry);
assert(!isPrivilegedDesktopInput('/checkout/apps/desktop/src/renderer/main.tsx'));
assert(!isPrivilegedDesktopInput('/checkout/apps/desktop/src/ipc/chat-wire.ts'));
assert(!isPrivilegedDesktopInput('/checkout/apps/desktop/src/preload/preload.ts'));
assert(!isPrivilegedDesktopInput('/checkout/apps/desktop/src/ipc/transcript-markdown.ts'));
