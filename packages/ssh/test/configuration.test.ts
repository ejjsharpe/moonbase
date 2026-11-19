import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Cause, Effect, Exit, Schema } from 'effect';
import type { SshConfiguration } from '@moonbase/ssh';
import {
  decodeSshConfiguration,
  SshConfigurationError,
  SshConfigurationSchema,
} from '@moonbase/ssh/configuration';

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

const decode = (value: unknown) => Effect.runSync(decodeSshConfiguration(value));
function rejected(value: unknown) {
  const exit = Effect.runSyncExit(decodeSshConfiguration(value));
  assert(Exit.isFailure(exit));
  assert(!JSON.stringify(exit).includes(configuration.token));
  assert(!JSON.stringify(exit).includes('private-credential-path'));
  const error = Cause.squash(exit.cause);
  assert(error instanceof SshConfigurationError);
  assert(!String(error).includes('SchemaError'));
}

test('public private-configuration schema resolves nullish executables and projects nested extras', () => {
  const expected = { ...configuration, sshExecutable: '/usr/bin/ssh' };
  assert.deepEqual(decode(configuration), expected);
  for (const sshExecutable of [undefined, null]) {
    const input = { ...configuration, sshExecutable };
    assert.deepEqual(decode(input), expected);
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
  const decoded = decode(extra);
  assert.deepEqual(decoded, expected);
  decoded.profile.expected.hostId = 'changed-copy';
  assert.equal(extra.profile.expected.hostId, configuration.profile.expected.hostId);
});

test('private configuration refuses representative invalid values with a static error', () => {
  const { profile, token } = configuration;
  const withProfile = (changes: Record<string, unknown>) => ({
    ...configuration,
    profile: { ...profile, ...changes },
  });
  const withExpected = (changes: Record<string, unknown>) =>
    withProfile({ expected: { ...profile.expected, ...changes } });
  for (const value of [
    'private-credential-path',
    { ...configuration, token: undefined },
    { ...configuration, token: 'a'.repeat(15) },
    { ...configuration, token: token + '\n' },
    { ...configuration, profile: null },
    withExpected({ hostId: undefined }),
    // Destinations that ssh would read as options, URLs, ports or shell syntax.
    withProfile({ destination: '-oProxyCommand=private-credential-path' }),
    withProfile({ destination: 'ssh://host' }),
    withProfile({ destination: 'host:22' }),
    withProfile({ destination: 'host;command' }),
    withProfile({ destination: 'host$(command)' }),
    withProfile({ destination: 'host\n' }),
    withProfile({ label: 'line\n' }),
    withProfile({ remotePort: 65536 }),
    withProfile({ remotePort: '8787' }),
    withProfile({ id: 'slash/id' }),
    { ...configuration, sshExecutable: 'relative/private-credential-path' },
    { ...configuration, sshExecutable: false },
    // The private key never lands in a public field.
    withProfile({ label: 'prefix-' + token }),
    withExpected({ storeId: 'prefix-' + token }),
    { ...configuration, sshExecutable: '/private-credential-path/' + token },
  ])
    rejected(value);
});

test('private configuration accepts destinations, ports, keys and paths at their bounds', () => {
  for (const [destination, remotePort] of [
    ['user@host.example', 1],
    ['user@[fe80::1%25]', 65535],
  ] as const)
    assert.equal(
      decode({
        ...configuration,
        profile: { ...configuration.profile, destination, remotePort },
      }).profile.destination,
      destination,
    );
  for (const token of ['a'.repeat(16), 'a'.repeat(4096)])
    assert.equal(decode({ ...configuration, token }).token, token);
  const bounded = { ...configuration.profile, id: 'i'.repeat(256), label: 'l'.repeat(128) };
  assert.deepEqual(decode({ ...configuration, profile: bounded }).profile, bounded);
  assert.equal(
    decode({ ...configuration, sshExecutable: '/private SSH resources/ssh' }).sshExecutable,
    '/private SSH resources/ssh',
  );
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
  assert(!inputs.some((path) => /packages\/application\//.test(path)));
  assert(
    !inputs.some((path) =>
      /packages\/(?:chat-runtime|daemon-protocol|workspace)|@earendil-works/.test(path),
    ),
  );
  assert(!result.outputFiles[0].text.includes('node:child_process'));
});
