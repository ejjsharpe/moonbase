import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  createCredentialStore,
  createKeyEncryption,
  createKeychainKeySource,
  createKeyFileSource,
  createMemoryKeySource,
  type CredentialKeySource,
  type KeychainKeySourceOptions,
} from '@moonbase/pi-runtime/credentials';

const secret = { type: 'api_key' as const, key: 'sk-private-credential-value' };
const macOnly =
  process.platform === 'darwin' ? false : 'the Keychain source needs macOS and /usr/bin/security';
if (macOnly) console.log(`Skipping Keychain tests: ${macOnly}.`);

async function makeDirectory(t: { after(fn: () => unknown): void }, prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function assertHidden(error: unknown, code: string, ...hidden: string[]) {
  assert(ApplicationError.is(error));
  assert.equal(error.code, code);
  for (const text of hidden) assert(!String(error).includes(text) && !error.stack?.includes(text));
  return true;
}

test('credentials round-trip under each key and tampered, truncated, swapped or wrong-key files fail without disclosure', async (t) => {
  const directory = await makeDirectory(t, 'moonbase-sealed-'),
    source = createMemoryKeySource(),
    store = createCredentialStore(directory, createKeyEncryption(source));
  assert.equal(await source.load(), undefined);
  await store.modify('openai-api-key', async () => secret);
  const key = (await source.load())!;
  assert.equal(key.byteLength, 32);
  assert.deepEqual(await store.read('openai-api-key'), secret);
  const path = join(directory, 'openai-api-key.encrypted'),
    sealed = await readFile(path);
  assert.equal(sealed[0], 1);
  assert(!sealed.includes(Buffer.from(secret.key)));
  // Every write draws a new nonce.
  await store.modify('openai-api-key', async () => secret);
  assert.notDeepEqual((await readFile(path)).subarray(1, 13), sealed.subarray(1, 13));
  await writeFile(path, sealed, { mode: 0o600 });

  const reject = async (bytes: Uint8Array, id = 'openai-api-key', reader = store) => {
    await writeFile(join(directory, id + '.encrypted'), bytes, { mode: 0o600 });
    await assert.rejects(reader.read(id), (error) =>
      assertHidden(error, 'Persistence', secret.key, Buffer.from(key).toString('base64')),
    );
  };
  for (const index of [0, 1, 13, sealed.length - 1]) {
    const tampered = Buffer.from(sealed);
    tampered[index]! ^= 1;
    await reject(tampered);
  }
  await reject(sealed.subarray(0, sealed.length - 1));
  await reject(sealed.subarray(0, 20));
  await reject(Buffer.alloc(0));
  await reject(sealed, 'anthropic');
  await rm(join(directory, 'anthropic.encrypted'));
  await writeFile(path, sealed, { mode: 0o600 });
  const otherKey = createCredentialStore(
    directory,
    createKeyEncryption(createMemoryKeySource(randomBytes(32))),
  );
  await reject(sealed, 'openai-api-key', otherKey);
  // Reading under a source with no key fails and creates none; only a write makes a key.
  const empty = createMemoryKeySource(),
    unkeyed = createCredentialStore(directory, createKeyEncryption(empty));
  await reject(sealed, 'openai-api-key', unkeyed);
  assert.equal(await empty.load(), undefined);
  assert.deepEqual(await readFile(path), sealed);
  const sameKey = createCredentialStore(directory, createKeyEncryption(createMemoryKeySource(key)));
  assert.deepEqual(await sameKey.read('openai-api-key'), secret);
});

test('an unavailable key source fails visibly and leaves stored credentials untouched', async (t) => {
  const directory = await makeDirectory(t, 'moonbase-unavailable-'),
    key = randomBytes(32);
  await createCredentialStore(directory, createKeyEncryption(createMemoryKeySource(key))).modify(
    'openai',
    async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 0 }),
  );
  const before = await readFile(join(directory, 'openai.encrypted'));
  let calls = 0;
  const locked: CredentialKeySource = {
    available: async () => true,
    load: async () => {
      calls++;
      throw new ApplicationError({ code: 'Unavailable', message: 'Keychain locked.' });
    },
    create: async () => {
      throw Error('must not create');
    },
  };
  const store = createCredentialStore(directory, createKeyEncryption(locked));
  await assert.rejects(store.read('openai'), { code: 'Unavailable', message: 'Keychain locked.' });
  await assert.rejects(
    store.modify('anthropic', async () => secret),
    { code: 'Unavailable' },
  );
  await assert.rejects(store.delete('openai'), { code: 'Unavailable' });
  assert.equal(calls, 3);
  assert.deepEqual(await readFile(join(directory, 'openai.encrypted')), before);
  assert.deepEqual((await readdir(directory)).sort(), ['openai.encrypted']);
  const absent = createCredentialStore(
    directory,
    createKeyEncryption({ ...locked, available: async () => false }),
  );
  await assert.rejects(absent.read('openai'), (error) => {
    assert(ApplicationError.is(error) && error.code === 'Unavailable');
    assert.match(error.message, /key file/);
    return true;
  });
});

test('a key file is created privately once, read back by later sources and refused unless private', async (t) => {
  const directory = await makeDirectory(t, 'moonbase-key-file-'),
    path = join(directory, 'credential.key');
  const created = await Promise.all(
    Array.from({ length: 8 }, () => createKeyFileSource(path).create()),
  );
  for (const key of created) assert.deepEqual(key, created[0]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, 'utf8'), /^[A-Za-z0-9+/]{43}=\n$/);
  assert.deepEqual(await readdir(directory), ['credential.key']);
  const credentials = join(directory, 'credentials');
  await createCredentialStore(credentials, createKeyEncryption(createKeyFileSource(path))).modify(
    'openai-api-key',
    async () => secret,
  );
  assert.deepEqual(
    await createCredentialStore(credentials, createKeyEncryption(createKeyFileSource(path))).read(
      'openai-api-key',
    ),
    secret,
  );
  assert.deepEqual(await createKeyFileSource(path).create(), created[0]);

  // A file made by hand, `openssl rand -base64 32`, works without a trailing newline too.
  const manual = join(directory, 'manual.key'),
    manualKey = randomBytes(32);
  await writeFile(manual, manualKey.toString('base64'), { mode: 0o600 });
  assert.deepEqual(await createKeyFileSource(manual).load(), new Uint8Array(manualKey));
  assert.equal(await createKeyFileSource(join(directory, 'absent.key')).load(), undefined);

  const refuse = async (target: string, operation: 'load' | 'create' = 'load') =>
    assert.rejects(createKeyFileSource(target)[operation](), (error) =>
      assertHidden(error, 'Unavailable', manualKey.toString('base64')),
    );
  await chmod(manual, 0o640);
  await refuse(manual);
  await chmod(manual, 0o604);
  await refuse(manual);
  await chmod(manual, 0o600);
  const link = join(directory, 'link.key');
  await symlink(manual, link);
  await refuse(link);
  await refuse(link, 'create');
  await refuse(directory);
  await refuse('relative/credential.key');
  for (const contents of ['not a key', randomBytes(16).toString('base64'), 'x'.repeat(200)]) {
    await writeFile(join(directory, 'bad.key'), contents, { mode: 0o600 });
    await refuse(join(directory, 'bad.key'));
  }
  await refuse(join(directory, 'missing', 'credential.key'), 'create');
  const shared = join(directory, 'shared');
  await mkdir(shared, { mode: 0o700 });
  await copyFile(manual, join(shared, 'credential.key'));
  await chmod(shared, 0o770);
  await refuse(join(shared, 'credential.key'));
  await refuse(join(shared, 'new.key'), 'create');
  assert.deepEqual((await readdir(shared)).sort(), ['credential.key']);
  // A create that can't write leaves nothing behind.
  await chmod(shared, 0o500);
  try {
    await refuse(join(shared, 'new.key'), 'create');
  } finally {
    await chmod(shared, 0o700);
  }
  assert.deepEqual(await readdir(shared), ['credential.key']);
});

type Spawned = { command: string; args: readonly string[]; env: NodeJS.ProcessEnv };
const fakeSecurity = `
IFS= read -r line
printf '%s\\n' "$line" >> "$1/stdin"
if [ -f "$1/status" ]; then exit "$(cat "$1/status")"; fi
case "$line" in
  find-generic-password*) [ -f "$1/item" ] || exit 44; cat "$1/item"; exit 0 ;;
  add-generic-password*) [ -f "$1/item" ] && exit 45
    printf '%s\\n' "$line" | sed -E 's/.* -w "([^"]*)".*/\\1/' > "$1/item"; exit 0 ;;
esac
exit 1
`;
/** Runs a shell stand-in for `/usr/bin/security`, recording what the source spawned. */
function observeSecurity(state: string, script = fakeSecurity) {
  const spawned: Spawned[] = [],
    children: ChildProcess[] = [];
  const spawnSecurity: NonNullable<KeychainKeySourceOptions['spawn']> = (
    command,
    args,
    options,
  ) => {
    spawned.push({ command, args: [...args], env: { ...options.env } });
    const child = spawn('/bin/sh', ['-c', script, 'security', state], options);
    children.push(child);
    return child as never;
  };
  return { spawned, children, spawn: spawnSecurity };
}

test(
  'the Keychain source writes only to security stdin and never puts the key in argv or the environment',
  { skip: macOnly },
  async (t) => {
    const state = await makeDirectory(t, 'moonbase-fake-security-'),
      fake = observeSecurity(state),
      source = createKeychainKeySource({
        storeId: 'store-1',
        keychain: join(state, 'test.keychain-db'),
        spawn: fake.spawn,
      });
    assert.equal(await source.available(), true);
    assert.equal(await source.load(), undefined);
    const key = await source.create(),
      encoded = Buffer.from(key).toString('base64');
    assert.deepEqual(await source.load(), key);
    assert.deepEqual(await source.create(), key);
    const directory = join(state, 'credentials'),
      store = createCredentialStore(directory, createKeyEncryption(source));
    await store.modify('openai-api-key', async () => secret);
    assert.deepEqual(
      await createCredentialStore(directory, createKeyEncryption(source)).read('openai-api-key'),
      secret,
    );
    assert(fake.spawned.length >= 5);
    for (const { command, args, env } of fake.spawned) {
      assert.equal(command, '/usr/bin/security');
      assert.deepEqual(args, ['-i']);
      for (const value of Object.values(env)) assert(!value?.includes(encoded));
    }
    const lines = (await readFile(join(state, 'stdin'), 'utf8')).trim().split('\n');
    const keychain = join(state, 'test.keychain-db');
    assert.equal(
      lines[0],
      `find-generic-password -s "Moonbase daemon credentials" -a "store-1" -w "${keychain}"`,
    );
    assert(
      lines.includes(
        `add-generic-password -s "Moonbase daemon credentials" -a "store-1" -w "${encoded}" "${keychain}"`,
      ),
    );
    assert.equal(lines.filter((line) => line.startsWith('add-')).length, 1);
  },
);

test(
  'a locked keychain, failing or hanging security and malformed items fail as Unavailable with no fallback',
  { skip: macOnly },
  async (t) => {
    const state = await makeDirectory(t, 'moonbase-failing-security-'),
      directory = join(state, 'credentials');
    const run = async (
      status: string | undefined,
      operation: 'load' | 'create',
      pattern: RegExp,
    ) => {
      if (status === undefined) await rm(join(state, 'status'), { force: true });
      else await writeFile(join(state, 'status'), status);
      const fake = observeSecurity(state),
        source = createKeychainKeySource({ storeId: 'store-1', spawn: fake.spawn });
      await assert.rejects(source[operation](), (error) => {
        assertHidden(error, 'Unavailable', 'generic-password', 'Moonbase daemon credentials');
        assert.match((error as Error).message, pattern);
        return true;
      });
      return fake;
    };
    await run('36', 'load', /locked.*key file/);
    await run('36', 'create', /locked.*key file/);
    await run('51', 'load', /status 51.*key file/);
    // A failed add is never followed by another source.
    await rm(join(state, 'item'), { force: true });
    const addFails = observeSecurity(
      state,
      fakeSecurity.replace('add-generic-password*) ', 'add-generic-password*) exit 25; '),
    );
    await rm(join(state, 'status'), { force: true });
    await assert.rejects(
      createKeychainKeySource({ storeId: 'store-1', spawn: addFails.spawn }).create(),
      /status 25/,
    );
    const store = createCredentialStore(
      directory,
      createKeyEncryption(createKeychainKeySource({ storeId: 'store-1', spawn: addFails.spawn })),
    );
    await assert.rejects(
      store.modify('openai-api-key', async () => secret),
      {
        code: 'Unavailable',
      },
    );
    assert.deepEqual(await readdir(directory), []);
    await writeFile(join(state, 'item'), 'not-a-key\n');
    await run(undefined, 'load', /not a Moonbase key/);
    await rm(join(state, 'item'));

    const noisy = observeSecurity(state, 'cat >/dev/null; head -c 8000 /dev/zero | tr "\\0" a');
    await assert.rejects(
      createKeychainKeySource({ storeId: 'store-1', spawn: noisy.spawn }).load(),
      { code: 'Unavailable' },
    );
    const missing = createKeychainKeySource({
      storeId: 'store-1',
      spawn: (_command, args, options) => spawn('/nonexistent/security', args, options) as never,
    });
    await assert.rejects(missing.load(), /security stopped/);

    // A command that outlives its budget is killed and reported.
    const hanging = observeSecurity(state, 'exec sleep 30'),
      started = Date.now();
    await assert.rejects(
      createKeychainKeySource({ storeId: 'store-1', spawn: hanging.spawn, timeoutMs: 100 }).load(),
      /security stopped/,
    );
    assert(Date.now() - started < 10_000);
    assert.equal(hanging.children[0]!.signalCode, 'SIGKILL');

    assert.throws(() => createKeychainKeySource({ storeId: 'bad id' }), { code: 'Unavailable' });
    for (const keychain of ['relative.keychain-db', '/tmp/a"b.keychain-db', '/tmp/a\nb'])
      assert.throws(() => createKeychainKeySource({ storeId: 'store-1', keychain }), {
        code: 'Unavailable',
      });
  },
);

test(
  'the Keychain source is unavailable off macOS and says to use a key file',
  { skip: !macOnly },
  async () => {
    const source = createKeychainKeySource({ storeId: 'store-1' });
    assert.equal(await source.available(), false);
    await assert.rejects(source.load(), /key file/);
  },
);

/** Runs one `security -i` command; the throwaway keychain password goes on stdin, never argv. */
function runSecurity(line: string) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject).on('close', resolve);
    child.stdin.end(line + '\n');
  });
}

test(
  'a temporary keychain stores, reads back and keeps the credential key',
  { skip: macOnly },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'moonbase-keychain-')),
      keychain = join(directory, 'test.keychain-db');
    // Delete the keychain by its path before its folder goes, so nothing outlives the test.
    t.after(async () => {
      try {
        assert.equal(await runSecurity(`delete-keychain "${keychain}"`), 0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    assert.equal(
      await runSecurity(`create-keychain -p "${randomBytes(24).toString('hex')}" "${keychain}"`),
      0,
    );
    const spawned: Spawned[] = [],
      observed: NonNullable<KeychainKeySourceOptions['spawn']> = (command, args, options) => {
        spawned.push({ command, args: [...args], env: { ...options.env } });
        return spawn(command, args, options) as never;
      };
    const source = createKeychainKeySource({ storeId: 'store-1', keychain, spawn: observed });
    assert.equal(await source.load(), undefined);
    const key = await source.create(),
      encoded = Buffer.from(key).toString('base64');
    const later = createKeychainKeySource({ storeId: 'store-1', keychain, spawn: observed });
    assert.deepEqual(await later.load(), key);
    assert.deepEqual(await later.create(), key);
    assert.equal(
      await createKeychainKeySource({ storeId: 'store-2', keychain, spawn: observed }).load(),
      undefined,
    );
    const credentials = join(directory, 'credentials');
    await createCredentialStore(credentials, createKeyEncryption(source)).modify(
      'openai-api-key',
      async () => secret,
    );
    assert.deepEqual(
      await createCredentialStore(credentials, createKeyEncryption(later)).read('openai-api-key'),
      secret,
    );
    assert(spawned.length >= 6);
    for (const { command, args, env } of spawned) {
      assert.equal(command, '/usr/bin/security');
      assert.deepEqual(args, ['-i']);
      for (const value of Object.values(env)) assert(!value?.includes(encoded));
    }
  },
);
