import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChildProcessSpawner, type ChildProcess } from 'effect/process';
import { makeKeychainKeySource } from '@moonbase/chat-runtime/credentials';
import { makeCredentialsFixture } from '../credentials-fixture.ts';

const secret = { type: 'api_key' as const, key: 'sk-private-credential-value' };
type Spawned = { command: string; args: readonly string[]; env: Record<string, unknown> };

/** Runs one `security -i` command; the throwaway keychain password goes on stdin, never argv. */
function runSecurity(line: string) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject).on('close', resolve);
    child.stdin.end(line + '\n');
  });
}
/** The user's keychain search list, read only; this suite never writes it. */
function listUserKeychains() {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['list-keychains', '-d', 'user'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child
      .on('error', reject)
      .on('close', (status) =>
        status === 0 ? resolve(output) : reject(Error(`security list-keychains exited ${status}`)),
      );
  });
}

// `security create-keychain` may add the new keychain to the user's search list, and a crash
// before cleanup would leave a dangling entry there, so this test runs only when asked, as on the
// ephemeral macOS CI runners. It checks the search list is unchanged and never writes it.
const realKeychain =
  process.env.MOONBASE_TEST_KEYCHAIN === '1'
    ? false
    : 'set MOONBASE_TEST_KEYCHAIN=1 to create and delete a temporary macOS keychain';
if (realKeychain) console.log(`Skipping the temporary-keychain test: ${realKeychain}.`);

test(
  'a temporary keychain stores, reads back and keeps the credential key',
  { skip: realKeychain },
  async (t) => {
    const searchList = await listUserKeychains(),
      directory = await mkdtemp(join(tmpdir(), 'moonbase-keychain-')),
      keychain = join(directory, 'test.keychain-db');
    // Delete the keychain by its path before its folder goes, so nothing outlives the test.
    t.after(async () => {
      try {
        assert.equal(await runSecurity(`delete-keychain "${keychain}"`), 0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      assert.equal(await listUserKeychains(), searchList);
    });
    assert.equal(
      await runSecurity(`create-keychain -p "${randomBytes(24).toString('hex')}" "${keychain}"`),
      0,
    );
    // The real spawner runs the real `security`; this only records what it was asked to run.
    const spawned: Spawned[] = [];
    const f = makeCredentialsFixture(t, (real) =>
      ChildProcessSpawner.make((command) => {
        const { options, args } = command as ChildProcess.StandardCommand;
        spawned.push({
          command: (command as ChildProcess.StandardCommand).command,
          args: [...args].map(String),
          env: { ...options.env },
        });
        return real.spawn(command);
      }),
    );
    const makeSource = (storeId: string) => f.run(makeKeychainKeySource({ storeId, keychain }));
    const source = await makeSource('store-1');
    assert.equal(await f.run(source.load), undefined);
    const key = await f.run(source.create),
      encoded = Buffer.from(key).toString('base64');
    const later = await makeSource('store-1');
    assert.deepEqual(await f.run(later.load), key);
    assert.deepEqual(await f.run(later.create), key);
    assert.equal(await f.run((await makeSource('store-2')).load), undefined);
    const credentials = join(directory, 'credentials');
    await (await f.keyedStore(credentials, source)).modify('openai-api-key', async () => secret);
    assert.deepEqual(await (await f.keyedStore(credentials, later)).read('openai-api-key'), secret);
    assert(spawned.length >= 6);
    for (const { command, args, env } of spawned) {
      assert.equal(command, '/usr/bin/security');
      assert.deepEqual(args, ['-i']);
      for (const value of Object.values(env)) assert(!String(value).includes(encoded));
    }
  },
);
