import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedRuntime } from 'effect';
import {
  ApplicationError,
  emptyRecovery,
  type CheckoutTarget,
  type EditorRecovery,
} from '@moonbase/contracts/workspace';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { WorkspaceLive } from './workspace-live.ts';
export const binary = fileURLToPath(new URL('../dist/filesystem', import.meta.url));
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-review-'))),
    root = join(base, 'repo'),
    dataDirectory = join(base, 'state');
  mkdirSync(root);
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'file.txt'), 'original');
  const start = (filesystemHelper = binary) => {
    const runtime = ManagedRuntime.make(
      WorkspaceLive({ dataDirectory, hostId: 'review-host', filesystemHelper }),
    );
    return { runtime, client: makeEditorClient(runtime) };
  };
  const wrapper = (body: string) => {
    const path = join(base, 'helper-' + Math.random());
    writeFileSync(path, '#!/bin/sh\n' + body + '\nexec ' + quote(binary) + ' "$@"\n');
    chmodSync(path, 0o700);
    return path;
  };
  return {
    base,
    root,
    start,
    wrapper,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
export const isError = (code: ApplicationError['code']) => (value: unknown) =>
  ApplicationError.is(value) && value.code === code;
export function state(
  checkout: CheckoutTarget,
  disk: { text: string; version: string },
  text = 'older draft',
): EditorRecovery {
  return {
    ...emptyRecovery('alice'),
    checkouts: [checkout],
    openCheckoutIds: [checkout.checkoutId],
    drafts: [{ target: { checkout, path: 'file.txt' }, disk, text }],
  };
}
export async function waitFor(path: string) {
  const deadline = Date.now() + 3000;
  while (!existsSync(path)) {
    assert(Date.now() < deadline, 'native helper did not reach barrier');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
