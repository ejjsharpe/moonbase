import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createCredentialStore } from '../src/credentials.ts';

test('credential persistence encrypts privately, serializes refresh and retains originals on encryption/storage failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-credentials-')),
    key = randomBytes(32);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let available = true,
    broken = false;
  const store = createCredentialStore(directory, {
    available: async () => available,
    encrypt: async (text) => {
      if (broken) throw Error('private secret diagnostic');
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]);
    },
    decrypt: async (bytes) => {
      const data = Buffer.from(bytes),
        decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString();
    },
  });
  const original = { type: 'api_key' as const, key: 'transient-api-secret' };
  await store.modify('openai-api-key', async () => original);
  const path = join(directory, 'openai-api-key.encrypted'),
    bytes = await readFile(path);
  assert(!bytes.includes(Buffer.from(original.key)));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.list(), [{ providerId: 'openai-api-key', type: 'api_key' }]);
  assert.deepEqual(await store.read('openai-api-key'), original);
  broken = true;
  await assert.rejects(
    store.modify('openai-api-key', async () => ({ type: 'api_key', key: 'replacement' })),
    (error: unknown) => {
      assert(!String(error).includes('secret diagnostic'));
      return true;
    },
  );
  assert.deepEqual(await readFile(path), bytes);
  available = false;
  await assert.rejects(store.delete('openai-api-key'));
  assert.deepEqual(await readFile(path), bytes);
  available = true;
  broken = false;
  await store.modify('openai', async () => ({
    type: 'oauth',
    access: 'access',
    refresh: '0',
    expires: 0,
  }));
  await Promise.all(
    Array.from({ length: 8 }, () =>
      store.modify('openai', async (current) => {
        assert.equal(current!.type, 'oauth');
        await new Promise((resolve) => setTimeout(resolve, 1));
        return {
          ...current!,
          type: 'oauth' as const,
          access: 'access',
          expires: 0,
          refresh: String(Number('refresh' in current! ? current.refresh : '') + 1),
        };
      }),
    ),
  );
  assert.equal(((await store.read('openai')) as { refresh: string }).refresh, '8');
  const before = await readFile(join(directory, 'openai.encrypted'));
  await assert.rejects(
    store.modify('openai', async () => {
      throw Error('refresh token secret');
    }),
  );
  assert.deepEqual(await readFile(join(directory, 'openai.encrypted')), before);
  await writeFile(path, Buffer.from('malformed ciphertext'));
  await assert.rejects(store.modify('openai-api-key', async () => original));
  assert.equal((await readFile(path)).toString(), 'malformed ciphertext');
});

test('pinned SDK refresh serializes encrypted credentials and persists rotated ChatGPT metadata after caller cancellation', async (t) => {
  const { createLocalModels } = await import('../src/local-models.ts');
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-sdk-refresh-')),
    key = randomBytes(32);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let encryptionBroken = false;
  const store = createCredentialStore(directory, {
    available: async () => true,
    encrypt: async (plain) => {
      if (encryptionBroken) throw Error('Private encryption diagnostic');
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    decrypt: async (bytes) => {
      const data = Buffer.from(bytes),
        decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString();
    },
  });
  const scopes = ['openid', 'offline_access', 'chatgpt.tokens.use.direct'];
  await store.modify('openai', async () => ({
    type: 'oauth',
    access: 'expired-access',
    refresh: 'original-refresh',
    expires: 0,
    clientId: 'issued-client',
    scopes,
  }));
  await store.modify('openai-api-key', async () => ({
    type: 'api_key',
    key: 'sk-independent-key',
  }));
  const models = createLocalModels(store),
    provider = models.getProvider('openai')!;
  const started = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  let refreshes = 0,
    refreshBroken = false,
    refreshSignal: AbortSignal | undefined;
  models.setProvider({
    ...provider,
    auth: {
      oauth: {
        ...provider.auth.oauth!,
        refresh: async (credential, signal) => {
          refreshes++;
          refreshSignal = signal;
          assert.equal(credential.clientId, 'issued-client');
          assert.deepEqual(credential.scopes, scopes);
          started.resolve();
          await released.promise;
          if (refreshBroken) throw Error('Private provider diagnostic');
          return {
            ...credential,
            access: 'rotated-access',
            refresh: 'rotated-refresh',
            expires: Date.now() + 3600000,
          };
        },
      },
    },
  });
  const abort = new AbortController();
  const first = models.getAuth('openai', { signal: abort.signal });
  await started.promise;
  const second = models.getAuth('openai');
  abort.abort();
  await assert.rejects(first);
  assert.equal(refreshSignal?.aborted, false);
  released.resolve();
  assert.equal((await second)?.auth.apiKey, 'rotated-access');
  assert.equal(refreshes, 1);
  const stored = await store.read('openai');
  assert.equal(stored?.type, 'oauth');
  if (stored?.type !== 'oauth') throw Error('Missing OAuth credential');
  assert.equal(stored.refresh, 'rotated-refresh');
  assert.equal(stored.clientId, 'issued-client');
  assert.deepEqual(stored.scopes, scopes);
  assert.equal((await models.getAuth('openai-api-key'))?.auth.apiKey, 'sk-independent-key');
  await store.modify('openai', async () => ({ ...stored, expires: 0 }));
  const path = join(directory, 'openai.encrypted'),
    before = await readFile(path);
  refreshBroken = true;
  await assert.rejects(models.getAuth('openai'), { code: 'oauth' });
  assert.deepEqual(await readFile(path), before);
  refreshBroken = false;
  encryptionBroken = true;
  await assert.rejects(models.getAuth('openai'), { code: 'auth' });
  assert.deepEqual(await readFile(path), before);
});
