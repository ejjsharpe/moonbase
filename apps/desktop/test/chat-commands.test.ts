import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  filterCommands,
  filterOptions,
  findCommandQuery,
  listChatCommands,
  removeCommandLine,
  resolveCommandLine,
  type ChatCommandContext,
} from '../src/renderer/chat/commands.ts';

const makeContext = (overrides: Partial<ChatCommandContext> = {}) => {
  const ran: string[] = [];
  const context: ChatCommandContext = {
    selected: false,
    running: false,
    models: [
      { value: 'fast', label: 'Fast model', current: true },
      { value: 'coding', label: 'Coding model' },
    ],
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
    ],
    newChat: () => ran.push('new'),
    stop: () => ran.push('stop'),
    clearDraft: () => ran.push('clear'),
    chooseModel: (value) => ran.push(`model ${value}`),
    chooseEffort: (value) => ran.push(`effort ${value}`),
    ...overrides,
  };
  return { context, ran };
};

test('the composer lists only commands it can run now', () => {
  const names = (overrides: Partial<ChatCommandContext>) =>
    listChatCommands(makeContext(overrides).context).map((command) => command.name);
  assert.deepEqual(names({}), ['model', 'effort', 'clear']);
  assert.deepEqual(names({ selected: true, running: true, models: [], efforts: [] }), [
    'new',
    'stop',
    'clear',
  ]);
});

test('a / opens commands only at the start of the first line, then a command’s choices', () => {
  const { context } = makeContext();
  const commands = listChatCommands(context);
  assert.deepEqual(findCommandQuery('/', 1, commands), { kind: 'command', query: '' });
  assert.deepEqual(findCommandQuery('/mo', 3, commands), { kind: 'command', query: 'mo' });
  assert.equal(findCommandQuery('Use /model', 10, commands), null);
  assert.equal(findCommandQuery('/model\n/', 8, commands), null);
  assert.equal(findCommandQuery('/clear now', 10, commands), null);
  const option = findCommandQuery('/effort hi', 10, commands);
  assert.equal(option?.kind, 'option');
  assert.equal(option?.kind === 'option' && option.command.name, 'effort');
  assert.equal(option?.query, 'hi');
  assert.deepEqual(
    filterCommands(commands, 'e').map((command) => command.name),
    ['effort', 'model', 'clear'],
  );
  assert.deepEqual(
    filterOptions(context.efforts, 'h').map((option) => option.value),
    ['high', 'xhigh'],
  );
  assert.deepEqual(
    filterOptions(context.models, 'cod').map((option) => option.value),
    ['coding'],
  );
});

test('a submitted command line runs its command or explains why it cannot', () => {
  const { context, ran } = makeContext();
  const commands = listChatCommands(context);
  const run = (text: string) => {
    const resolved = resolveCommandLine(text, commands);
    if (resolved && 'command' in resolved) resolved.command.run(resolved.option);
    return resolved && 'error' in resolved ? resolved.error : resolved;
  };
  assert.equal(run('/usr/bin is missing'), null);
  assert.equal(run('Please /clear'), null);
  run('/clear');
  run('/effort  HIGH ');
  run('/model cod\nand then this');
  assert.deepEqual(ran, ['clear', 'effort high', 'model coding']);
  assert.equal(run('/stop'), "/stop isn't available here.");
  assert.equal(run('/clear all'), '/clear takes no argument.');
  assert.equal(run('/effort'), 'Choose a reasoning effort for /effort.');
  assert.equal(run('/model model'), 'More than one model matches “model”.');
  assert.equal(run('/effort turbo'), 'No reasoning effort matches “turbo”.');
  assert.equal(removeCommandLine('/model cod\nand then this'), 'and then this');
  assert.equal(removeCommandLine('/clear'), '');
});

test('commands open only at the end of the first line, so picking one never drops text after it', () => {
  const { context } = makeContext({ selected: true });
  const commands = listChatCommands(context);
  assert.equal(findCommandQuery('/fix the login bug\nsecond line', 1, commands), null);
  assert.equal(findCommandQuery('/model fast', 3, commands), null);
  assert.equal(findCommandQuery('/mo fast', 3, commands), null);
  assert.deepEqual(findCommandQuery('/ne\nsecond line', 3, commands), {
    kind: 'command',
    query: 'ne',
  });
  assert.equal(findCommandQuery('/effort hi', 10, commands)?.kind, 'option');
  assert.equal(findCommandQuery('/effort hi', 9, commands), null);
});
