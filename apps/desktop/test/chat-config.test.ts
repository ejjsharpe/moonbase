import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfiguration } from '../src/chat/config.ts';
test('private configuration is owner-only, bounded, explicit and projected; bad files never initialize transport', async (t) => {
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
  assert.equal(result.ssh.sshExecutable, undefined);
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
