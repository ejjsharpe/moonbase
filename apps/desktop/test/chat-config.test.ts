import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfiguration } from '../src/chat/config.ts';
test('private configuration is owner-only, bounded, explicit and projected; bad files never initialize transport', async (t) => {
  await assert.rejects(readConfiguration(''), {
    code: 'InvalidInput',
    message: 'Set MOONBASE_CHAT_CONFIG to an absolute private configuration file.',
  });
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-chat-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'private.json'),
    value = {
      profile: {
        id: 'one',
        label: 'Personal',
        destination: 'trusted-alias',
        remotePort: 8787,
        expected: { hostId: 'host', storeId: 'store' },
      },
      actorId: 'owner',
      token: 'synthetic-test-private-key-with-entropy',
    };
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const result = await readConfiguration(path);
  assert.deepEqual(result.context, { host: value.profile.expected, actorId: 'owner' });
  assert(!JSON.stringify(result.context).includes(value.token));
  assert.equal(result.ssh.sshExecutable, '/usr/bin/ssh');
  await writeFile(path, JSON.stringify({ ...value, sshExecutable: '/usr/bin/ssh' }));
  assert.equal((await readConfiguration(path)).ssh.sshExecutable, '/usr/bin/ssh');
  for (const invalid of [
    null,
    [],
    { ...value, profile: { ...value.profile, extra: value.token } },
    {
      ...value,
      profile: {
        ...value.profile,
        expected: { ...value.profile.expected, privateKey: value.token },
      },
    },
    { ...value, token: { secret: value.token } },
    { ...value, token: value.token.repeat(150) },
    { ...value, actorId: 'invalid actor' },
    { ...value, sshExecutable: 'relative/ssh' },
    { ...value, sshExecutable: null },
    { ...value, profile: { ...value.profile, remotePort: '8787' } },
    { ...value, profile: { ...value.profile, label: 1 } },
    { ...value, profile: { ...value.profile, destination: null } },
  ]) {
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(readConfiguration(path), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'InvalidInput');
      assert(!String(error).includes(value.token));
      assert(!String(error).includes(path));
      return true;
    });
  }
  await writeFile(path, JSON.stringify(value));
  await chmod(path, 0o644);
  await assert.rejects(readConfiguration(path));
  await chmod(path, 0o600);
  const link = join(directory, 'link');
  await symlink(path, link);
  await assert.rejects(readConfiguration(link));
  await writeFile(path, JSON.stringify({ ...value, unknownPrivateField: 'not allowed' }));
  await assert.rejects(readConfiguration(path));
  await writeFile(path, ' '.repeat(16385));
  await assert.rejects(readConfiguration(path));
  await assert.rejects(readConfiguration('relative.json'));
});
