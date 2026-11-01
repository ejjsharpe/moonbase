import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime-client';
import { WorkspaceLive } from '../src/index.ts';
const [root, dataDirectory, file] = process.argv.slice(2);
if (!root || !dataDirectory || !file) throw Error('Usage: node --experimental-strip-types packages/workspace/examples/local.ts ABSOLUTE_CHECKOUT ABSOLUTE_FRESH_MOONBASE_STATE RELATIVE_FILE');
const runtime = ManagedRuntime.make(WorkspaceLive({dataDirectory, hostId: 'local-example', ...(process.env.MOONBASE_RIPGREP ? {ripgrepExecutable: process.env.MOONBASE_RIPGREP} : {})}));
try {
  const client = makeEditorClient(runtime);
  const checkout = await client.command('openCheckout', {root});
  console.log({checkout, document: await client.command('readFile', {checkout, path: file}), git: await client.command('gitStatus', {checkout})});
} finally { await runtime.dispose(); }
