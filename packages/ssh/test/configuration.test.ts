import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Schema } from 'effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import type { SshConfiguration } from '@moonbase/ssh';
import { decodeSshConfiguration, SshConfigurationSchema } from '@moonbase/ssh/configuration';

const configuration: SshConfiguration = {
  profile: {
    id: 'configured',
    label: 'Operator host',
    destination: 'operator@configured-alias',
    remotePort: 8787,
    expected: { hostId: 'explicit-host', storeId: 'explicit-store' },
  },
  token: 'synthetic-private-host-key',
};

function rejected(value: unknown) {
  assert.throws(
    () => decodeSshConfiguration(value),
    (error) => {
      assert(ApplicationError.is(error));
      assert.equal(error.code, 'InvalidInput');
      assert.equal(error.message, 'Invalid SSH configuration.');
      assert(!JSON.stringify(error).includes(configuration.token));
      assert(!JSON.stringify(error).includes('private-credential-path'));
      assert(!String(error).includes('SchemaError'));
      return true;
    },
  );
}

test('public private-configuration schema resolves nullish executables and projects nested extras', () => {
  const expected = { ...configuration, sshExecutable: '/usr/bin/ssh' };
  assert.deepEqual(decodeSshConfiguration(configuration), expected);
  for (const sshExecutable of [undefined, null]) {
    const input = { ...configuration, sshExecutable };
    assert.deepEqual(decodeSshConfiguration(input), expected);
    assert.deepEqual(Schema.decodeUnknownSync(SshConfigurationSchema)(input), expected);
  }
  const extra = {
    ...configuration,
    credential: configuration.token,
    profile: {
      ...configuration.profile,
      token: configuration.token,
      expected: { ...configuration.profile.expected, token: configuration.token },
    },
  };
  const decoded = decodeSshConfiguration(extra);
  assert.deepEqual(decoded, expected);
  decoded.profile.expected.hostId = 'changed-copy';
  assert.equal(extra.profile.expected.hostId, configuration.profile.expected.hostId);
});

test('private configuration rejects missing and incorrectly typed fields with static errors', () => {
  for (const value of [undefined, null, false, 1, 'private-credential-path', [], {}])
    rejected(value);
  for (const token of [undefined, null, false, 1, [], {}]) rejected({ ...configuration, token });
  for (const profile of [undefined, null, false, 1, [], {}])
    rejected({ ...configuration, profile });
  for (const field of ['id', 'label', 'destination', 'remotePort', 'expected'])
    for (const value of [undefined, null, false, {}, []])
      rejected({ ...configuration, profile: { ...configuration.profile, [field]: value } });
  for (const field of ['hostId', 'storeId'])
    for (const value of [undefined, null, 1, false, {}, []])
      rejected({
        ...configuration,
        profile: {
          ...configuration.profile,
          expected: { ...configuration.profile.expected, [field]: value },
        },
      });
  for (const sshExecutable of [false, 1, [], {}]) rejected({ ...configuration, sshExecutable });
});

test('profile validation retains destination grammar, label controls, ports and identity bounds', () => {
  const profile = configuration.profile;
  for (const destination of [
    '',
    '-oProxyCommand=private-credential-path',
    'ssh://host',
    'host:22',
    'host;command',
    'host$(command)',
    'host`command`',
    'host|command',
    'host name',
    'host\n',
    'host\0',
    'u'.repeat(65) + '@host',
    'h'.repeat(254),
    '[' + 'a'.repeat(320) + ']',
  ])
    rejected({ ...configuration, profile: { ...profile, destination } });
  for (const label of ['', 'a'.repeat(129), 'line\n', 'tab\t', 'null\0', 'delete\x7f'])
    rejected({ ...configuration, profile: { ...profile, label } });
  for (const remotePort of [0, -1, 65536, 1.5, Infinity, NaN, '8787'])
    rejected({ ...configuration, profile: { ...profile, remotePort } });
  for (const id of ['', 'a'.repeat(257), 'has space', 'line\n', 'slash/id', 'é']) {
    rejected({ ...configuration, profile: { ...profile, id } });
    for (const field of ['hostId', 'storeId'])
      rejected({
        ...configuration,
        profile: { ...profile, expected: { ...profile.expected, [field]: id } },
      });
  }
  for (const destination of ['alias', 'user@host.example', '[::1]', 'user@[fe80::1%25]'])
    for (const remotePort of [1, 65535])
      assert.equal(
        decodeSshConfiguration({
          ...configuration,
          profile: { ...profile, destination, remotePort },
        }).profile.destination,
        destination,
      );
  const bounded = { ...profile, id: 'i'.repeat(256), label: 'l'.repeat(128) };
  assert.deepEqual(decodeSshConfiguration({ ...configuration, profile: bounded }).profile, bounded);
});

test('private keys and executables retain bounds, path validation and public-field separation', () => {
  for (const token of [
    '',
    'a'.repeat(15),
    'a'.repeat(4097),
    'contains a space',
    'synthetic-private-host-key\n',
    'synthetic-private-host-key\t',
    'synthetic-private-host-key\0',
    'synthetic-private-host-keyé',
  ])
    rejected({ ...configuration, token });
  for (const token of ['a'.repeat(16), 'a'.repeat(4096), '!'.repeat(16), '~'.repeat(16)])
    assert.equal(decodeSshConfiguration({ ...configuration, token }).token, token);
  for (const sshExecutable of [
    '',
    'relative/private-credential-path',
    '/private-credential-path\0',
  ])
    rejected({ ...configuration, sshExecutable });
  assert.equal(
    decodeSshConfiguration({ ...configuration, sshExecutable: '/private SSH resources/ssh' })
      .sshExecutable,
    '/private SSH resources/ssh',
  );
  const token = configuration.token;
  for (const field of ['id', 'label', 'destination'])
    rejected({
      ...configuration,
      profile: { ...configuration.profile, [field]: 'prefix-' + token },
    });
  for (const field of ['hostId', 'storeId'])
    rejected({
      ...configuration,
      profile: {
        ...configuration.profile,
        expected: { ...configuration.profile.expected, [field]: 'prefix-' + token },
      },
    });
  rejected({ ...configuration, sshExecutable: '/private-credential-path/' + token });
});

test('hostile private values do not escape through decoder diagnostics', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw configuration.token;
      },
    },
  );
  rejected(hostile);
  rejected({ ...configuration, profile: hostile });
  rejected({
    ...configuration,
    sshExecutable: {
      toString() {
        throw configuration.token;
      },
    },
  });
});

test('the configuration subpath has no SSH process or application service graph', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
    entryPoints: ['@moonbase/ssh/configuration'],
    bundle: true,
    platform: 'node',
    write: false,
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert(inputs.some((path) => path.endsWith('packages/ssh/src/configuration.ts')));
  assert(!inputs.some((path) => /packages\/ssh\/src\/(?:index|process)\.ts$/.test(path)));
  assert(
    !inputs.some((path) =>
      /packages\/application\/src\/(?:services|handlers|runtime-client|host-health)\.ts$/.test(
        path,
      ),
    ),
  );
  assert(!inputs.some((path) => /packages\/(?:pi-runtime|workspace)|@earendil-works/.test(path)));
  assert(!result.outputFiles[0].text.includes('node:child_process'));
});
