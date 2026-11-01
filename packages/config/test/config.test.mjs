import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const tools = (name) => path.join(root, 'node_modules', name, 'bin', name);

// Exercise the actual root overrides in an isolated monorepo, without linting invalid fixtures in CI.
test('Oxlint correctness baseline, native React checks and standalone formatting', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'moonbase-config-'));
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    writeFileSync(path.join(directory, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(directory, 'package.json'), '{"private": true, "type": "module"}');
    for (const config of ['oxlint.config.mts', 'oxfmt.config.mts']) {
      copyFileSync(path.join(root, config), path.join(directory, config));
    }
    const fixtures = {
      'packages/shared/constants.js': 'const value = 1; value = 2; console.log(value);',
      'packages/shared/unused.ts': 'const unused: Array<string> = [];',
      'packages/shared/array.js': 'export const array = new Array(10);',
      'scripts/node.js': 'export const buffer = new Buffer(1);',
      'apps/desktop/src/renderer/keys.jsx': 'export const view = [<div />, <span />];',
      'apps/desktop/src/renderer/hooks.tsx':
        'import { useState } from "react";\nexport function View({ enabled }) { if (enabled) useState(0); return <div />; }',
      'scripts/order.mjs':
        'import z from "node:zlib";\nimport a from "node:assert";\nconsole.log(z, a);',
      'docs/source-snapshot/invalid.js': 'const = broken;',
    };
    for (const [name, source] of Object.entries(fixtures)) {
      const file = path.join(directory, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    const lint = spawnSync(process.execPath, [tools('oxlint'), '.', '--format=json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(lint.status, 1, lint.stderr || lint.stdout);
    const { diagnostics } = JSON.parse(lint.stdout);
    const codes = (file) =>
      diagnostics.filter((item) => item.filename.endsWith(file)).map((item) => item.code);
    assert(codes('constants.js').includes('eslint(no-const-assign)'));
    assert(codes('unused.ts').includes('eslint(no-unused-vars)'));
    assert(codes('array.js').includes('unicorn(no-new-array)'), JSON.stringify(diagnostics));
    assert(codes('keys.jsx').includes('react(jsx-key)'), JSON.stringify(diagnostics));
    assert(!codes('unused.ts').includes('typescript(array-type)'));
    assert(!codes('node.js').includes('unicorn(no-new-buffer)'));
    assert(!codes('hooks.tsx').includes('react-hooks(rules-of-hooks)'));
    assert(!codes('order.mjs').length);
    assert(
      diagnostics.every((item) => item.code && item.severity === 'error'),
      JSON.stringify(diagnostics),
    );
    assert.deepEqual(codes('invalid.js'), []);

    const format = spawnSync(process.execPath, [tools('oxfmt'), '--stdin-filepath=example.tsx'], {
      cwd: directory,
      input:
        'export const view = <button\n title="A fairly long button title to push the element over the line width"\n disabled={true}\n>"hello"</button>',
      encoding: 'utf8',
    });
    assert.equal(format.status, 0, format.stderr);
    assert.match(format.stdout, /disabled=\{true\}>/);
    const quotes = spawnSync(process.execPath, [tools('oxfmt'), '--stdin-filepath=example.ts'], {
      cwd: directory,
      input: 'export const value="hello"',
      encoding: 'utf8',
    });
    assert.equal(quotes.status, 0, quotes.stderr);
    assert.equal(quotes.stdout, "export const value = 'hello';\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
