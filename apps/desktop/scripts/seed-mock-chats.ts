/**
 * Seeds a fresh dev profile's daemon directory with scripted local chats, before its daemon first
 * starts, so every transcript row kind is visible without provider credentials. A faux model plays
 * each turn against the daemon's own store; its tool calls run for real, so edits and failing
 * commands only touch a mock project created inside the profile, and the chat in the repository
 * itself only reads. The daemon then starts with this identity and these chats.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { LocalPiRuntimeLive } from '@moonbase/chat-runtime';

const userData = process.argv[2];
if (!userData) throw Error('Pass the dev profile directory.');
const repository = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const directory = join(userData, 'daemon-v1');
const project = join(userData, 'mock-project');

const transcriptSource = `import { useScrollAnchor } from './transcript-geometry';

export function Transcript({ rows }: { rows: Row[] }) {
  const anchor = useScrollAnchor(listRef, rows);
  useLayoutEffect(() => anchor.restore(), [rows]);
  return <VirtualList rows={rows} />;
}
`;

await mkdir(userData, { recursive: true, mode: 0o700 });
// `mkdir` without `recursive` refuses an existing directory, so a daemon's data is never seeded.
await mkdir(directory, { mode: 0o700 });
await mkdir(join(project, 'src'), { recursive: true });
await writeFile(join(project, 'README.md'), '# Mock project\n\nScratch files for seeded chats.\n');
await writeFile(join(project, 'src', 'transcript.tsx'), transcriptSource);
const session = { host: { hostId: randomUUID(), storeId: randomUUID() }, actorId: randomUUID() };
// `wx` refuses an existing identity, so seeding never orphans a profile's chats.
await writeFile(join(directory, 'identity.json'), JSON.stringify(session), {
  mode: 0o600,
  flag: 'wx',
});

// The daemon refuses a store that isn't private, and SQLite gives its WAL files the store's mode.
await (await open(join(directory, 'chat.sqlite'), 'wx', 0o600)).close();
const models = createModels(),
  faux = fauxProvider({ models: [{ id: 'mock-model', reasoning: true }], tokensPerSecond: 4000 });
models.setProvider(faux.provider);
const runtime = ManagedRuntime.make(
  LocalPiRuntimeLive({ ...session, databasePath: join(directory, 'chat.sqlite'), models }),
);
const client = makeChatClient(runtime);

const toolUse = { stopReason: 'toolUse' as const };
async function seedChat(
  title: string,
  cwd: string,
  turns: { text: string; steps: FauxResponseStep[] }[],
) {
  const created = await client.command('createChat', {
    session,
    requestId: randomUUID(),
    title,
    settings: { cwd, model: { provider: faux.provider.id, modelId: 'mock-model' } },
  });
  const target: ChatTarget = created.conversation.target;
  for (const turn of turns) {
    faux.setResponses(turn.steps);
    await client.command('sendChat', { target, requestId: randomUUID(), text: turn.text });
    for (let i = 0; ; i++) {
      const snapshot = await client.command('getChat', { target });
      if (!snapshot.run && snapshot.state !== 'running') break;
      if (i > 600) throw Error(`"${title}" did not settle.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

try {
  await seedChat('Move the transcript to Legend List', project, [
    {
      text: 'Move the transcript to Legend List and drop the scroll-anchoring workarounds it makes unnecessary.',
      steps: [
        fauxAssistantMessage(
          [
            fauxThinking(
              'The anchor hook only exists to fight the old virtualizer. Read it first.',
            ),
            fauxToolCall('read', { path: 'src/transcript.tsx' }),
          ],
          toolUse,
        ),
        fauxAssistantMessage(
          fauxToolCall('bash', { command: 'grep -rn "scrollAnchor\\|ScrollAnchor" src' }),
          toolUse,
        ),
        fauxAssistantMessage(
          fauxToolCall('edit', {
            path: 'src/transcript.tsx',
            edits: [
              {
                oldText:
                  '  const anchor = useScrollAnchor(listRef, rows);\n  useLayoutEffect(() => anchor.restore(), [rows]);\n  return <VirtualList rows={rows} />;',
                newText:
                  '  return (\n    <LegendList data={rows} keyExtractor={rowKey} maintainScrollAtEnd />\n  );',
              },
            ],
          }),
          toolUse,
        ),
        fauxAssistantMessage(
          fauxToolCall('bash', { command: 'ls src/transcript-geometry.ts' }),
          toolUse,
        ),
        fauxAssistantMessage(
          [
            '## Moved to Legend List',
            '',
            'Rows are keyed `entry:<id>`, so the manual **anchor** code is gone:',
            '',
            '- `useScrollAnchor` and its restore effect are removed',
            '- `maintainScrollAtEnd` keeps the latest reply in view',
            '- `transcript-geometry.ts` was already deleted, so nothing else imports it',
            '',
            '```tsx',
            'return <LegendList data={rows} keyExtractor={rowKey} maintainScrollAtEnd />;',
            '```',
          ].join('\n'),
        ),
      ],
    },
    {
      text: 'Nice. What should I check before merging?',
      steps: [
        fauxAssistantMessage(
          [
            '| Check | Why |',
            '| --- | --- |',
            '| Reading positions | the anchor used to restore them |',
            '| Streaming replies | the list must stay pinned to the end |',
            '',
            '> Run the transcript browser tests; they cover both.',
          ].join('\n'),
        ),
      ],
    },
  ]);
  await seedChat('Summarise this repository', repository, [
    {
      text: 'Give me a quick tour of this repository.',
      steps: [
        fauxAssistantMessage(fauxToolCall('read', { path: 'README.md', limit: 40 }), toolUse),
        fauxAssistantMessage(fauxToolCall('bash', { command: 'git log --oneline -5' }), toolUse),
        fauxAssistantMessage(
          'Moonbase is a **Bun monorepo**: packages own behaviour and `apps/desktop` composes them into the Electron app. The recent commits are the redesign phases: tokens, the project rail, worktrees, Changes and the project dock.',
        ),
      ],
    },
  ]);
  await seedChat('Plain question', project, [
    {
      text: 'What does ⌘J do?',
      steps: [fauxAssistantMessage('It shows or hides the project dock beside the editor.')],
    },
  ]);
  console.log(`Seeded mock chats. Mock project: ${project}`);
} finally {
  await runtime.dispose();
}
