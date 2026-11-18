import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  daemonCommandCapabilities,
  daemonInputSchemas,
  decodeDaemonInput,
  decodeDaemonOutput,
  isDaemonCommand,
  isDaemonMutation,
  maximumHostFolders,
  maximumRecentFolders,
} from '../src/daemon-schema.ts';
import { readProviderSignInUrl } from '../src/providers-schema.ts';
import * as Schema from 'effect/Schema';
import { folderReadErrors } from '../src/daemon-rpc.ts';
import { FolderRefusedError } from '../src/folder-errors.ts';
import { decodeConnectionProfile } from '../src/connection-schema.ts';
import { chatHostCapabilities, chatProtocolVersion } from '../src/host.ts';
import { decodeChatHostHealth } from '../src/host-schema.ts';

const host = { hostId: 'host', storeId: 'store' };
const state = { providers: [], flow: null };

test('every daemon operation names one advertised capability; mutations are exactly those with request IDs', () => {
  const operations = Object.keys(daemonInputSchemas);
  assert.deepEqual(Object.keys(daemonCommandCapabilities).sort(), [...operations].sort());
  for (const capability of Object.values(daemonCommandCapabilities))
    assert(Object.values(chatHostCapabilities).includes(capability));
  assert.deepEqual(operations.filter((operation) => isDaemonMutation(operation as never)).sort(), [
    'answerProviderPrompt',
    'approveFolder',
    'cancelProviderLogin',
    'logoutProvider',
    'markFolderAsProject',
    'startProviderLogin',
  ]);
  for (const operation of operations) {
    const fields = Object.keys(
      (daemonInputSchemas as Record<string, { fields: object }>)[operation]!.fields,
    );
    assert.equal(fields.includes('requestId'), isDaemonMutation(operation as never), operation);
  }
  assert(!isDaemonCommand('setAdmissionsOpen'));
  assert(!isDaemonCommand('sendChat'));
});

test('daemon inputs decode strictly and within bounds', () => {
  assert.deepEqual(
    decodeDaemonInput('approveFolder', { host, requestId: 'r', path: '/folder', recent: false }),
    { host, requestId: 'r', path: '/folder', recent: false },
  );
  for (const [operation, input] of [
    ['approveFolder', { host, requestId: 'r', path: 'relative' }],
    ['approveFolder', { host, requestId: 'r', path: '/a\0b' }],
    ['approveFolder', { host, path: '/folder' }],
    ['approveFolder', { host, requestId: 'r', path: '/folder', extra: true }],
    [
      'answerProviderPrompt',
      { host, ownerId: 'o', requestId: 'r', flowId: 'f', promptId: 'p', answer: 'x'.repeat(16385) },
    ],
    ['setAdmissionsOpen', { host, open: false }],
  ] as const)
    assert.throws(() => decodeDaemonInput(operation as never, input));
});

test('daemon replies decode strictly, bounding folders and validating sign-in links', () => {
  const folders = Array.from({ length: maximumRecentFolders }, (_, i) => `/folder-${i}`);
  assert.deepEqual(decodeDaemonOutput('listRecentFolders', { folders }), { folders });
  const hostFolders = Array.from({ length: maximumHostFolders }, (_, i) => `/root/folder-${i}`);
  assert.deepEqual(decodeDaemonOutput('listHostFolders', { folders: hostFolders }), {
    folders: hostFolders,
  });
  assert.equal(decodeDaemonOutput('checkChatFolder', undefined), undefined);
  assert.equal(decodeDaemonOutput('checkApprovedFolder', undefined), undefined);
  const url = 'https://auth.openai.com/api/accounts/authorize?state=1';
  assert.deepEqual(decodeDaemonOutput('openProviderUrl', { state, url }), { state, url });
  for (const [operation, output] of [
    ['listRecentFolders', { folders: [...folders, '/one-more'] }],
    ['listHostFolders', { folders: ['relative'] }],
    ['getProviders', { state, extra: true }],
    ['openProviderUrl', { state, url: 'https://evil.example/' }],
  ] as const)
    assert.throws(() => decodeDaemonOutput(operation as never, output), Schema.isSchemaError);
});

test('sign-in links are accepted only as https pages on a provider sign-in origin', () => {
  assert.equal(
    readProviderSignInUrl('https://auth.openai.com/oauth?x=1'),
    'https://auth.openai.com/oauth?x=1',
  );
  for (const value of [
    'http://auth.openai.com/',
    'https://auth.openai.com.evil.example/',
    'https://evil.example/?https://auth.openai.com',
    'https://user:pass@auth.openai.com/',
    'https://auth.openai.com:444/',
    'javascript:alert(1)',
    'not a url',
    42,
    'https://auth.openai.com/' + 'x'.repeat(8192),
  ])
    assert.equal(readProviderSignInUrl(value), undefined, String(value));
});

test('health accepts the current protocol with daemon capabilities and refuses an older one', () => {
  const health = {
    ...host,
    protocol: chatProtocolVersion,
    version: '0.1.0',
    capabilities: Object.values(chatHostCapabilities),
  };
  assert.deepEqual(decodeChatHostHealth(health), health);
  assert.throws(
    () => decodeChatHostHealth({ ...health, protocol: chatProtocolVersion - 1 }),
    Schema.isSchemaError,
  );
});

test('a daemon error crosses the wire as its tag and fields only, and decodes to its own text', () => {
  const schema = Schema.Union(folderReadErrors);
  const encode = Schema.encodeSync(schema),
    decode = Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' });
  const error = Object.assign(new FolderRefusedError({ refusal: 'not-approved', use: 'search' }), {
    cause: '/private/path',
  });
  const encoded = encode(error);
  assert.deepEqual(encoded, { _tag: 'FolderRefusedError', refusal: 'not-approved', use: 'search' });
  assert.equal(decode(encoded).message, error.message);
  // A host can't name a reason the client doesn't know, nor send its own text.
  assert.throws(() => decode({ ...encoded, refusal: 'host text' }));
  assert.throws(() => decode({ ...encoded, message: 'host text' }));
});

test('a connection profile may leave out its port until a loopback connection has read one', () => {
  const profile = { id: 'loopback', label: 'This Mac', destination: '127.0.0.1', expected: host };
  assert.deepEqual(decodeConnectionProfile(profile), profile);
  assert.throws(() => decodeConnectionProfile({ ...profile, remotePort: 0 }));
});
