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
    '@moonbase/pi-runtime',
    { directory: 'packages/pi-runtime', exports: { '.': './src/index.ts' } },
  ],
  [
    '@moonbase/ssh',
    { directory: 'packages/ssh', exports: { './host-health': './src/host-health.ts' } },
  ],
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
  "type Backend = import('@moonbase/pi-runtime').Backend;",
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
    check({ 'apps/desktop/src/main.ts': `import '${specifier}';` }).some((error) =>
      error.includes('public package export'),
    ),
  );
assert(
  check({ 'packages/workbench/src/index.ts': "import type {} from '@moonbase/pi-runtime';" }).some(
    (error) => error.includes('presentation depends on infrastructure'),
  ),
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
    'packages/pi-runtime/examples/remote.ts': "import '@moonbase/application/runtime/clients';",
  }),
  [],
);
assert(
  check({
    'packages/pi-runtime/src/index.ts': "import './resources.ts';",
    'packages/pi-runtime/src/resources.ts': "import './commands.ts';",
    'packages/pi-runtime/src/commands.ts': "import '../examples/remote.ts';",
    'packages/pi-runtime/examples/remote.ts': "import '@moonbase/application';",
    'packages/application/src/index.ts': '',
  }).some((error) => error.includes('reusable export reaches process root')),
);
assert(
  check({
    'packages/pi-runtime/src/index.ts': "import './resources.ts';",
    'packages/pi-runtime/src/resources.ts': "import './commands.ts';",
    'packages/pi-runtime/src/commands.ts': "import type {} from '@moonbase/application';",
    'packages/application/src/index.ts': '',
  }).some((error) => error.includes('reusable infrastructure')),
);
assert.deepEqual(
  check({
    'packages/pi-runtime/src/index.ts': "import '@moonbase/ssh/host-health';",
    'packages/ssh/src/host-health.ts':
      "import '@moonbase/contracts'; import '@moonbase/effect'; import 'node:crypto';",
    'packages/contracts/src/index.ts': '',
    'packages/effect/src/index.ts': "import '@moonbase/contracts';",
  }),
  [],
);
assert(
  check({
    'packages/ssh/src/host-health.ts': "import type {} from './process.ts';",
    'packages/ssh/src/process.ts': '',
  }).some((error) => error.includes('named authentication helper reaches implementation')),
);
assert(
  check({
    'packages/contracts/src/index.ts': "import '@moonbase/effect';",
    'packages/effect/src/index.ts': '',
  }).some((error) => error.includes('contracts depends on executable')),
);
console.log(
  'Boundary negative fixtures passed: platform/type/dynamic/deep imports, cycles and hidden process-root back edges.',
);

for (const entry of [
  'main.ts',
  'main/native-actions.ts',
  'main/ipc.ts',
  'main/window-lifecycle.ts',
  'main/chat-backends.ts',
  'main/future-owner.ts',
  'ipc-lifetime.ts',
  'chat/local.ts',
])
  assert(isPrivilegedDesktopInput(`/checkout/apps/desktop/src/${entry}`), entry);
assert(!isPrivilegedDesktopInput('/checkout/apps/desktop/src/renderer/main.tsx'));
assert(!isPrivilegedDesktopInput('/checkout/apps/desktop/src/chat/wire.ts'));
