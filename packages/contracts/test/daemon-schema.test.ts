import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  daemonCommandCapabilities,
  daemonInputSchemas,
  decodeDaemonInput,
  decodeDaemonOutput,
  isDaemonCommand,
  isDaemonMutation,
  maximumRecentFolders,
} from '../src/daemon-schema.ts';
import { readProviderSignInUrl } from '../src/providers-schema.ts';
import { chatHostCapabilities } from '../src/host.ts';
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
    ['approveFolder', { host, requestId: 'r', path: '/' + 'x'.repeat(4096) }],
    ['approveFolder', { host, requestId: 'r', path: '/a\0b' }],
    ['approveFolder', { host, path: '/folder' }],
    ['approveFolder', { host, requestId: 'r', path: '/folder', extra: true }],
    ['getActiveWork', { host: { ...host, extra: 1 } }],
    ['getProviders', { host, ownerId: 'owner with spaces' }],
    ['getProviders', { host }],
    [
      'answerProviderPrompt',
      { host, ownerId: 'o', requestId: 'r', flowId: 'f', promptId: 'p', answer: 'x'.repeat(16385) },
    ],
    ['markFolderAsProject', { requestId: 'r', target: { host, actorId: 'a' } }],
    ['setAdmissionsOpen', { host, open: false }],
  ] as const)
    assert.throws(() => decodeDaemonInput(operation as never, input), { code: 'InvalidInput' });
});

test('daemon replies decode strictly, bounding folders and validating sign-in links', () => {
  const folders = Array.from({ length: maximumRecentFolders }, (_, i) => `/folder-${i}`);
  assert.deepEqual(decodeDaemonOutput('listRecentFolders', { folders }), { folders });
  assert.equal(decodeDaemonOutput('checkChatFolder', undefined), undefined);
  const url = 'https://auth.openai.com/api/accounts/authorize?state=1';
  assert.deepEqual(decodeDaemonOutput('openProviderUrl', { state, url }), { state, url });
  for (const [operation, output] of [
    ['listRecentFolders', { folders: [...folders, '/one-more'] }],
    ['listRecentFolders', { folders: ['relative'] }],
    ['approveFolder', { path: '/folder' }],
    ['getActiveWork', { active: 'no' }],
    ['getProviders', { state, extra: true }],
    ['openProviderUrl', { state, url: 'https://evil.example/' }],
    ['openProviderUrl', { state, url: 'https://auth.openai.com/a b' }],
    ['startProviderLogin', { state }],
  ] as const)
    assert.throws(() => decodeDaemonOutput(operation as never, output), { code: 'Incompatible' });
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

test('health accepts protocol 2 with daemon capabilities and refuses protocol 1', () => {
  const health = {
    ...host,
    protocol: 2,
    version: '0.1.0',
    capabilities: Object.values(chatHostCapabilities),
  };
  assert.deepEqual(decodeChatHostHealth(health), health);
  assert.throws(() => decodeChatHostHealth({ ...health, protocol: 1 }), { code: 'Incompatible' });
});
