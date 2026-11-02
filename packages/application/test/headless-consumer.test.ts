import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkHeadlessApplication } from '../examples/headless.ts';
import { decodeChatInput, decodeChatOutput } from '@moonbase/contracts/chat-schema';
import { decodeEditorRecovery } from '@moonbase/contracts/workspace-schema';
import { decodeApplicationErrorDTO } from '@moonbase/contracts/error-schema';
import { chatCapabilities } from './chat-capabilities.ts';

test('a direct public consumer runs editor-only, chat-only and combined applications', async () => {
  assert.deepEqual(await checkHeadlessApplication(), ['editor', 'chat', 'combined']);
});

test('baseline command data, recovery, snapshots and public error DTOs survive serialization', () => {
  const fixture = (name: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../../../docs/fixtures/headless-baseline/${name}-v1.txt`, import.meta.url),
        'utf8',
      ),
    );
  const send = decodeChatInput('sendChat', fixture('send'));
  const data = {
    send,
    result: decodeChatOutput('sendChat', {
      target: send.target,
      requestId: send.requestId,
      admission: 'admitted',
      submissionId: 'submission',
    }),
    stop: decodeChatInput('stopChat', fixture('stop')),
    recovery: decodeEditorRecovery(fixture('recovery')),
    snapshot: chatCapabilities().snapshot,
    error: decodeApplicationErrorDTO({ code: 'Cancelled', message: 'Command cancelled' }),
  };
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
  assert.equal(data.stop.stop.taskId, null);
  assert.equal(data.send.text, '  Keep original text  ');
});
