import assert from 'node:assert/strict';
import { test } from 'node:test';
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
import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { CredentialKeyError } from '@moonbase/contracts/provider-errors';
import {
  createMemoryKeySource,
  makeKeychainKeySource,
  makeKeyFileSource,
  type CredentialKeySource,
  type KeychainKeySourceOptions,
} from '@moonbase/chat-runtime/credentials';
import { makeCredentialsFixture } from './credentials-fixture.ts';

/** Whether a process this test started still exists. */
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ESRCH') return false;
    throw error;
  }
};
const secret = { type: 'api_key' as const, key: 'sk-private-credential-value' };

async function makeDirectory(t: { after(fn: () => unknown): void }, prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function assertHidden(error: unknown, tag: string, ...hidden: string[]) {
  assert(error instanceof Error);
  assert.equal((error as { _tag?: string })._tag, tag);
  for (const text of hidden) assert(!String(error).includes(text) && !error.stack?.includes(text));
  return true;
}

/** A source whose effects fail or count as `load` and `create` say. */
const makeSource = (source: {
  available?: () => boolean;
  load: () => Promise<Uint8Array | undefined> | Uint8Array | undefined;
  create: () => Promise<Uint8Array> | Uint8Array;
}): CredentialKeySource => {
  const attempt = <A>(run: () => Promise<A> | A) =>
    Effect.tryPromise({
      try: async () => run(),
      catch: (error) => error as CredentialKeyError,
    });
  return {
    available: Effect.sync(source.available ?? (() => true)),
    load: attempt(source.load),
    create: attempt(source.create),
  };
};
const locked = () => {
  throw new CredentialKeyError({ problem: 'keychain-locked' });
};

test('credentials round-trip under each key and tampered, truncated, swapped or wrong-key files fail without disclosure', async (t) => {
  const directory = await makeDirectory(t, 'moonbase-sealed-'),
    f = makeCredentialsFixture(t),
    source = createMemoryKeySource(),
    store = await f.keyedStore(directory, source);
  assert.equal(await f.run(source.load), undefined);
  await store.modify('openai-api-key', async () => secret);
  const key = (await f.run(source.load))!;
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
      assertHidden(error, 'CredentialStoreError', secret.key, Buffer.from(key).toString('base64')),
    );
  };
  for (const index of [1, sealed.length - 1]) {
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
  const otherKey = await f.keyedStore(directory, createMemoryKeySource(randomBytes(32)));
  await reject(sealed, 'openai-api-key', otherKey);
  // Reading under a source with no key fails and creates none; only a write makes a key.
  const empty = createMemoryKeySource(),
    unkeyed = await f.keyedStore(directory, empty);
  await reject(sealed, 'openai-api-key', unkeyed);
  assert.equal(await f.run(empty.load), undefined);
  assert.deepEqual(await readFile(path), sealed);
  const sameKey = await f.keyedStore(directory, createMemoryKeySource(key));
  assert.deepEqual(await sameKey.read('openai-api-key'), secret);
});

test('an unavailable key source fails visibly and leaves stored credentials untouched', async (t) => {
  const directory = await makeDirectory(t, 'moonbase-unavailable-'),
    f = makeCredentialsFixture(t),
    key = randomBytes(32);
  await (
    await f.keyedStore(directory, createMemoryKeySource(key))
  ).modify('openai', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 0 }));
  const before = await readFile(join(directory, 'openai.encrypted'));
  let calls = 0;
  const lockedSource = makeSource({
    load: () => {
      calls++;
      return locked();
    },
    create: () => {
      throw Error('must not create');
    },
  });
  const store = await f.keyedStore(directory, lockedSource);
  await assert.rejects(store.read('openai'), {
    _tag: 'CredentialKeyError',
    problem: 'keychain-locked',
  });
  await assert.rejects(
    store.modify('anthropic', async () => secret),
    { _tag: 'CredentialKeyError' },
  );
  await assert.rejects(store.delete('openai'), { _tag: 'CredentialKeyError' });
  assert.equal(calls, 3);
  assert.deepEqual(await readFile(join(directory, 'openai.encrypted')), before);
  assert.deepEqual((await readdir(directory)).sort(), ['openai.encrypted']);
  const absent = await f.keyedStore(directory, {
    ...lockedSource,
    available: Effect.succeed(false),
  });
  await assert.rejects(absent.read('openai'), (error) => {
    assert(error instanceof CredentialKeyError);
    assert.match(error.message, /key file/);
    return true;
  });
});

test('signing in again replaces an unreadable credential and signing out removes it, but a locked keychain or private-file failure never does', async (t) => {
  const directory = await makeDirectory(t, 'moonbase-unreadable-'),
    f = makeCredentialsFixture(t),
    path = join(directory, 'openai-api-key.encrypted'),
    replacement = { type: 'api_key' as const, key: 'sk-replacement-value' };
  const seal = async (key: Uint8Array) => {
    await rm(path, { force: true });
    await (
      await f.keyedStore(directory, createMemoryKeySource(key))
    ).modify('openai-api-key', async () => secret);
    return readFile(path);
  };
  const sealed = await seal(randomBytes(32)),
    key = randomBytes(32);
  const truncated = sealed.subarray(0, 20),
    tampered = Buffer.from(sealed);
  tampered[20]! ^= 1;

  // Under another key, a tampered or truncated file, and a file that decrypts to no credential.
  const plainKey = randomBytes(32),
    garbage = await f.encryption(createMemoryKeySource(plainKey));
  const notCredential = Buffer.from(
    await f.run(garbage.encrypt('{"type":"other"}', 'openai-api-key')),
  );
  for (const bytes of [sealed, tampered, truncated, notCredential]) {
    const current = bytes === notCredential ? plainKey : key;
    await writeFile(path, bytes, { mode: 0o600 });
    const store = await f.keyedStore(directory, createMemoryKeySource(current));
    await assert.rejects(store.read('openai-api-key'), (error) => {
      assertHidden(error, 'CredentialStoreError', secret.key);
      assert.match((error as Error).message, /Sign in to that provider again/);
      assert.doesNotMatch((error as Error).message, /keychain/i);
      return true;
    });
    let seen: unknown = 'not called';
    await store.modify('openai-api-key', async (value) => ((seen = value), replacement));
    assert.equal(seen, undefined);
    assert.deepEqual(await store.read('openai-api-key'), replacement);
    await writeFile(path, bytes, { mode: 0o600 });
    await store.delete('openai-api-key');
    await assert.rejects(stat(path), { code: 'ENOENT' });
    assert.equal(await store.read('openai-api-key'), undefined);
  }

  // With no key at all, signing in makes one and replaces the file, which no key can ever open.
  await writeFile(path, sealed, { mode: 0o600 });
  const fresh = createMemoryKeySource(),
    unkeyed = await f.keyedStore(directory, fresh);
  await unkeyed.modify('openai-api-key', async () => replacement);
  assert((await f.run(fresh.load))?.byteLength === 32);
  assert.deepEqual(await unkeyed.read('openai-api-key'), replacement);

  // A locked keychain is Unavailable for every file, readable or not, and nothing changes.
  const lockedCalls = { load: 0, create: 0 };
  const lockedStore = await f.keyedStore(
    directory,
    makeSource({
      load: () => {
        lockedCalls.load++;
        return locked();
      },
      create: () => {
        lockedCalls.create++;
        return locked();
      },
    }),
  );
  for (const bytes of [sealed, truncated]) {
    await writeFile(path, bytes, { mode: 0o600 });
    await assert.rejects(
      lockedStore.modify('openai-api-key', async () => replacement),
      { _tag: 'CredentialKeyError' },
    );
    await assert.rejects(lockedStore.delete('openai-api-key'), { _tag: 'CredentialKeyError' });
    assert.deepEqual(await readFile(path), bytes);
  }
  assert.equal(lockedCalls.create, 0);
  // A key that can't be created, such as a keychain that locks between read and write, keeps it.
  const unwritable = await f.keyedStore(directory, {
    ...createMemoryKeySource(),
    create: Effect.fail(new CredentialKeyError({ problem: 'keychain-locked' })),
  });
  await assert.rejects(
    unwritable.modify('openai-api-key', async () => replacement),
    { _tag: 'CredentialKeyError' },
  );
  assert.deepEqual(await readFile(path), truncated);

  // A file that fails the private-file checks, or encryption that fails for another reason, is kept.
  const keyed = await f.keyedStore(directory, createMemoryKeySource(key));
  await chmod(path, 0o644);
  await assert.rejects(
    keyed.modify('openai-api-key', async () => replacement),
    {
      _tag: 'CredentialStoreError',
    },
  );
  await assert.rejects(keyed.delete('openai-api-key'), { _tag: 'CredentialStoreError' });
  assert.deepEqual(await readFile(path), truncated);
  await chmod(path, 0o600);
  await writeFile(path, Buffer.alloc(128 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(
    keyed.modify('openai-api-key', async () => replacement),
    {
      _tag: 'CredentialStoreError',
    },
  );
  assert.equal((await stat(path)).size, 128 * 1024 + 1);
  await writeFile(path, sealed, { mode: 0o600 });
  const failing = await f.store(directory, {
    available: Effect.succeed(true),
    encrypt: () => Effect.succeed(Buffer.alloc(0)),
    decrypt: () =>
      Effect.sync(() => {
        throw Error('safeStorage could not decrypt');
      }),
  });
  await assert.rejects(
    failing.modify('openai-api-key', async () => replacement),
    {
      _tag: 'CredentialStoreError',
    },
  );
  await assert.rejects(failing.delete('openai-api-key'));
  assert.deepEqual(await readFile(path), sealed);
});

test('parallel reads share one key load, parallel first writes one create, and a failed load is retried', async (t) => {
  const directory = await makeDirectory(t, 'moonbase-coalesce-'),
    f = makeCredentialsFixture(t),
    key = randomBytes(32),
    providers = ['openai', 'anthropic', 'google'] as const;
  const seeded = await f.keyedStore(directory, createMemoryKeySource(key));
  for (const id of providers) await seeded.modify(id, async () => secret);
  // Each call stays in flight a moment, so concurrent callers overlap it.
  const count = (inner: CredentialKeySource, failLoads = 0) => {
    const calls = { load: 0, create: 0 };
    const source: CredentialKeySource = {
      available: inner.available,
      load: Effect.sync(() => ++calls.load).pipe(
        Effect.tap(() => Effect.sleep('10 millis')),
        Effect.flatMap((call) =>
          call <= failLoads
            ? Effect.fail(new CredentialKeyError({ problem: 'keychain-locked' }))
            : inner.load,
        ),
      ),
      create: Effect.sync(() => calls.create++).pipe(
        Effect.andThen(Effect.sleep('10 millis')),
        Effect.andThen(inner.create),
      ),
    };
    return { calls, source };
  };

  const reader = count(createMemoryKeySource(key));
  const store = await f.keyedStore(directory, reader.source);
  assert.equal((await store.list()).length, providers.length);
  await Promise.all(providers.map((id) => store.read(id)));
  assert.deepEqual(reader.calls, { load: 1, create: 0 });

  const writer = count(createMemoryKeySource()),
    fresh = await f.keyedStore(join(directory, 'fresh'), writer.source);
  await Promise.all(providers.map((id) => fresh.modify(id, async () => secret)));
  assert.deepEqual(writer.calls, { load: 1, create: 1 });
  for (const id of providers) assert.deepEqual(await fresh.read(id), secret);
  assert.deepEqual(writer.calls, { load: 1, create: 1 });

  // A locked keychain is asked once per attempt, and unlocking it lets the next attempt succeed.
  const lockedOnce = count(createMemoryKeySource(key), 1),
    retrying = await f.keyedStore(directory, lockedOnce.source);
  await assert.rejects(retrying.list(), { _tag: 'CredentialKeyError', problem: 'keychain-locked' });
  assert.equal(lockedOnce.calls.load, 1);
  assert.equal((await retrying.list()).length, providers.length);
  assert.equal(lockedOnce.calls.load, 2);

  // A failed create is retried too, and a store with no key never caches the absence.
  let failCreate = true;
  const flaky = count({
    ...createMemoryKeySource(),
    create: Effect.suspend(() =>
      failCreate
        ? Effect.fail(new CredentialKeyError({ problem: 'keychain-locked' }))
        : createMemoryKeySource(key).create,
    ),
  });
  const flakyStore = await f.keyedStore(join(directory, 'flaky'), flaky.source);
  await assert.rejects(
    flakyStore.modify('openai', async () => secret),
    CredentialKeyError,
  );
  failCreate = false;
  await flakyStore.modify('openai', async () => secret);
  assert.deepEqual(await flakyStore.read('openai'), secret);
  assert.deepEqual(flaky.calls, { load: 2, create: 2 });
});

test('a key file is created privately once, read back by later sources and refused unless private', async (t) => {
  const directory = await makeDirectory(t, 'moonbase-key-file-'),
    f = makeCredentialsFixture(t),
    path = join(directory, 'credential.key');
  const keyFile = (target: string) => f.run(makeKeyFileSource(target));
  const created = await Promise.all(
    Array.from({ length: 8 }, async () => f.run((await keyFile(path)).create)),
  );
  for (const key of created) assert.deepEqual(key, created[0]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, 'utf8'), /^[A-Za-z0-9+/]{43}=\n$/);
  assert.deepEqual(await readdir(directory), ['credential.key']);
  const credentials = join(directory, 'credentials');
  await (
    await f.keyedStore(credentials, await keyFile(path))
  ).modify('openai-api-key', async () => secret);
  assert.deepEqual(
    await (await f.keyedStore(credentials, await keyFile(path))).read('openai-api-key'),
    secret,
  );
  assert.deepEqual(await f.run((await keyFile(path)).create), created[0]);

  // A file made by hand, `openssl rand -base64 32`, works without a trailing newline too.
  const manual = join(directory, 'manual.key'),
    manualKey = randomBytes(32);
  await writeFile(manual, manualKey.toString('base64'), { mode: 0o600 });
  assert.deepEqual(await f.run((await keyFile(manual)).load), new Uint8Array(manualKey));
  assert.equal(await f.run((await keyFile(join(directory, 'absent.key'))).load), undefined);

  const refuse = async (target: string, operation: 'load' | 'create' = 'load') =>
    assert.rejects(f.run((await keyFile(target))[operation]), (error) =>
      assertHidden(error, 'CredentialKeyError', manualKey.toString('base64')),
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
  // A key of the wrong length is refused.
  await writeFile(join(directory, 'bad.key'), randomBytes(16).toString('base64'), { mode: 0o600 });
  await refuse(join(directory, 'bad.key'));
  // A root-owned folder that only root can change, such as a system directory, is private enough.
  assert.equal(await f.run((await keyFile('/usr/bin/moonbase-absent.key')).load), undefined);
  for (const operation of ['load', 'create'] as const)
    await assert.rejects(
      f.run((await keyFile(join(directory, 'missing', 'credential.key')))[operation]),
      { _tag: 'CredentialKeyError', problem: 'file-folder-missing' },
    );
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

type Spawned = { command: string; args: readonly string[]; env: Record<string, unknown> };
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
/**
 * Runs a shell stand-in for `/usr/bin/security` with the options the source gave, recording what
 * it spawned and each process it started.
 */
function observeSecurity(
  t: { after(fn: () => unknown): void },
  state: string,
  script = fakeSecurity,
) {
  const spawned: Spawned[] = [],
    pids: number[] = [];
  const fixture = makeCredentialsFixture(t, (real) =>
    ChildProcessSpawner.make((command) => {
      const { options, args } = command as ChildProcess.StandardCommand;
      spawned.push({
        command: (command as ChildProcess.StandardCommand).command,
        args: [...args].map(String),
        env: { ...options.env },
      });
      return real
        .spawn(ChildProcess.make('/bin/sh', ['-c', script, 'security', state], options))
        .pipe(Effect.tap((handle) => Effect.sync(() => pids.push(handle.pid))));
    }),
  );
  /** A Keychain source that takes the faked `security` as present, so it runs on any OS. */
  const source = (options: KeychainKeySourceOptions) =>
    fixture.run(makeKeychainKeySource({ available: Effect.succeed(true), ...options }));
  return { ...fixture, spawned, pids, source };
}

test('the Keychain source writes only to security stdin and never puts the key in argv or the environment', async (t) => {
  const state = await makeDirectory(t, 'moonbase-fake-security-'),
    fake = observeSecurity(t, state),
    source = await fake.source({ storeId: 'store-1', keychain: join(state, 'test.keychain-db') });
  assert.equal(await fake.run(source.available), true);
  assert.equal(await fake.run(source.load), undefined);
  const key = await fake.run(source.create),
    encoded = Buffer.from(key).toString('base64');
  assert.deepEqual(await fake.run(source.load), key);
  assert.deepEqual(await fake.run(source.create), key);
  const directory = join(state, 'credentials'),
    store = await fake.keyedStore(directory, source);
  await store.modify('openai-api-key', async () => secret);
  assert.deepEqual(await (await fake.keyedStore(directory, source)).read('openai-api-key'), secret);
  assert(fake.spawned.length >= 5);
  for (const { command, args, env } of fake.spawned) {
    assert.equal(command, '/usr/bin/security');
    assert.deepEqual(args, ['-i']);
    for (const value of Object.values(env)) assert(!String(value).includes(encoded));
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
});

test('a locked keychain, failing or hanging security and malformed items fail as Unavailable with no fallback', async (t) => {
  const state = await makeDirectory(t, 'moonbase-failing-security-'),
    directory = join(state, 'credentials');
  const run = async (status: string | undefined, operation: 'load' | 'create', pattern: RegExp) => {
    if (status === undefined) await rm(join(state, 'status'), { force: true });
    else await writeFile(join(state, 'status'), status);
    const fake = observeSecurity(t, state),
      source = await fake.source({ storeId: 'store-1' });
    await assert.rejects(fake.run(source[operation]), (error) => {
      assertHidden(error, 'CredentialKeyError', 'generic-password', 'Moonbase daemon credentials');
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
    t,
    state,
    fakeSecurity.replace('add-generic-password*) ', 'add-generic-password*) exit 25; '),
  );
  await rm(join(state, 'status'), { force: true });
  await assert.rejects(
    addFails.run((await addFails.source({ storeId: 'store-1' })).create),
    /status 25/,
  );
  const store = await addFails.keyedStore(directory, await addFails.source({ storeId: 'store-1' }));
  await assert.rejects(
    store.modify('openai-api-key', async () => secret),
    {
      _tag: 'CredentialKeyError',
    },
  );
  assert.deepEqual(await readdir(directory), []);
  await writeFile(join(state, 'item'), 'not-a-key\n');
  await run(undefined, 'load', /not a Moonbase key.*sign in .* again/);
  await rm(join(state, 'item'));

  const noisy = observeSecurity(t, state, 'cat >/dev/null; head -c 8000 /dev/zero | tr "\\0" a');
  await assert.rejects(noisy.run((await noisy.source({ storeId: 'store-1' })).load), {
    _tag: 'CredentialKeyError',
  });
  const missing = makeCredentialsFixture(t, (real) =>
    ChildProcessSpawner.make((command) =>
      real.spawn(
        ChildProcess.make(
          '/nonexistent/security',
          ['-i'],
          (command as ChildProcess.StandardCommand).options,
        ),
      ),
    ),
  );
  await assert.rejects(
    missing.run(
      Effect.flatMap(
        makeKeychainKeySource({ storeId: 'store-1', available: Effect.succeed(true) }),
        (source) => source.load,
      ),
    ),
    /security stopped/,
  );

  // A command that outlives its budget is killed and reported; it ignores SIGTERM, so only
  // SIGKILL ends it.
  const hanging = observeSecurity(t, state, "trap '' TERM; exec sleep 30"),
    started = Date.now();
  await assert.rejects(
    hanging.run((await hanging.source({ storeId: 'store-1', timeoutMs: 100 })).load),
    /security stopped/,
  );
  assert(Date.now() - started < 10_000);
  assert.equal(isRunning(hanging.pids[0]!), false);

  const keychainFixture = observeSecurity(t, state);
  await assert.rejects(keychainFixture.source({ storeId: 'bad id' }), {
    _tag: 'CredentialKeyError',
  });
  for (const keychain of [
    'relative.keychain-db',
    '/tmp/a"b.keychain-db',
    "/tmp/a'b.keychain-db",
    '/tmp/a\\b.keychain-db',
    '/tmp/a\nb',
    // Too long for one `security -i` line once the add command and key are included.
    '/' + 'k'.repeat(4000),
    '/' + 'é'.repeat(2000),
  ])
    await assert.rejects(keychainFixture.source({ storeId: 'store-1', keychain }), {
      _tag: 'CredentialKeyError',
    });
});

test('the Keychain source is unavailable off macOS and says to use a key file', async (t) => {
  const f = makeCredentialsFixture(t),
    source = await f.run(
      makeKeychainKeySource({ storeId: 'store-1', available: Effect.succeed(false) }),
    );
  assert.equal(await f.run(source.available), false);
  await assert.rejects(f.run(source.load), /key file/);
  await assert.rejects(f.run(source.create), /key file/);
});
