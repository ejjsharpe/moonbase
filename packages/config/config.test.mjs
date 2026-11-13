import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tools = (name) => path.join(root, 'node_modules', name, 'bin', name);

// Exercise the actual root overrides in an isolated monorepo, without linting invalid fixtures in CI.
test('Native correctness and project rules reject violations and preserve documented exceptions', () => {
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
      'packages/shared/unsafe.ts': 'export const value: any = 1;',
      'packages/shared/ignored.ts':
        '// @ts-ignore\n// @ts-nocheck\n// @ts-expect-error: short\nexport const value = 1;',
      'packages/shared/allowed-directive.ts':
        '// @ts-expect-error: deliberately invalid type for a regression fixture\nexport const value: string = 42;',
      'packages/shared/model.ts': 'export interface Entry { readonly value: string }',
      'packages/shared/type-import.ts':
        'import { Entry } from "./model"; export const read = (entry: Entry) => entry.value;',
      'packages/shared/Panel.tsx': 'export const Panel = () => <div />;',
      'packages/shared/ternary.js':
        'export const choose = (first, second) => first ? (second ? 1 : 2) : 3;',
      'packages/shared/switch.js':
        'export function choose(value) { switch(value) { case 1: const result = 1; console.log(result); case 2: return 2; default: return 0; } }',
      'packages/shared/equality.js': 'export const equals = (left, right) => left == right;',
      'packages/shared/allowed-equality.js': 'export const isAbsent = (value) => value == null;',
      'packages/shared/mutable.js':
        'export function value() { var count = 1; let offset = 2; return count + offset; }',
      'apps/desktop/src/renderer/attribute.jsx': 'export const view = <div class="panel" />;',
      'scripts/builtin.mjs': 'import path from "path"; export const joined = path.join("a", "b");',
      'scripts/order.mjs':
        'import z from "node:zlib";\nimport a from "node:assert";\nconsole.log(z, a);',
      'dist/invalid.js': 'const = broken;',
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
    assert(codes('unused.ts').includes('typescript(array-type)'));
    assert(!codes('node.js').includes('unicorn(no-new-buffer)'));
    assert(codes('hooks.tsx').includes('react-hooks(rules-of-hooks)'));
    assert(codes('unsafe.ts').includes('typescript(no-explicit-any)'));
    assert.equal(
      codes('ignored.ts').filter((code) => code === 'typescript(ban-ts-comment)').length,
      3,
    );
    assert.deepEqual(codes('allowed-directive.ts'), []);
    assert(codes('type-import.ts').includes('typescript(consistent-type-imports)'));
    assert.deepEqual(codes('Panel.tsx'), []);
    assert(codes('ternary.js').includes('eslint(no-nested-ternary)'));
    assert(codes('switch.js').includes('eslint(no-fallthrough)'));
    assert(codes('switch.js').includes('eslint(no-case-declarations)'));
    assert(codes('equality.js').includes('eslint(eqeqeq)'));
    assert.deepEqual(codes('allowed-equality.js'), []);
    assert(codes('mutable.js').includes('eslint(no-var)'));
    assert(codes('mutable.js').includes('eslint(prefer-const)'));
    assert(codes('attribute.jsx').includes('react(no-unknown-property)'));
    assert(codes('builtin.mjs').includes('unicorn(prefer-node-protocol)'));
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
