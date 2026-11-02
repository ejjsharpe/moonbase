import assert from 'node:assert/strict';
import { checkBoundaries, imports } from './boundaries.mjs';

const packages = new Map([
  [
    '@moonbase/application',
    {
      directory: 'packages/application',
      exports: { '.': './src/index.ts', './runtime-client': './src/index.ts' },
    },
  ],
  ['@moonbase/contracts', { directory: 'packages/contracts', exports: { '.': './src/index.ts' } }],
  [
    '@moonbase/pi-runtime',
    { directory: 'packages/pi-runtime', exports: { '.': './src/index.ts' } },
  ],
]);
function check(sources) {
  return checkBoundaries({
    packages,
    files: new Map(Object.entries(sources).map(([path, source]) => [path, imports(source, path)])),
  });
}
assert.deepEqual(check({ 'packages/application/src/index.ts': 'export const value = 1;' }), []);
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
  check({ 'packages/pi-runtime/src/host.ts': "import '@moonbase/application/runtime-client';" }),
  [],
);
assert(
  check({
    'packages/pi-runtime/src/index.ts': "export * from './host.ts';",
    'packages/pi-runtime/src/host.ts': "import '@moonbase/application';",
    'packages/application/src/index.ts': '',
  }).some((error) => error.includes('reusable export reaches process root')),
);
assert(
  check({
    'packages/pi-runtime/src/index.ts': "export * from './service.ts';",
    'packages/pi-runtime/src/service.ts': "import type {} from '@moonbase/application';",
    'packages/application/src/index.ts': '',
  }).some((error) => error.includes('reusable infrastructure')),
);
console.log(
  'Boundary negative fixtures passed: platform/type/dynamic/deep imports, cycles and hidden process-root back edges.',
);
