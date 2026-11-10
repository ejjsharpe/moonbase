import { chmod, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A stand-in for the Claude Code CLI: it reports a subscription login, starts the inert tool
// inventory exactly as Claude Code would and streams scripted turns without any network. Like an
// npm install, it runs through `env node`, with its `node` beside it.
const source = (directory: string) => `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
const directory = ${JSON.stringify(directory)};
appendFileSync(directory + '/invocations.log', JSON.stringify(process.argv.slice(2, 4)) + '\\n');
if (process.argv.includes('auth') && process.argv.includes('status')) {
  const loggedIn = !process.env.FAKE_CLAUDE_LOGGED_OUT;
  console.log(JSON.stringify(loggedIn ? { loggedIn, authMethod: 'claude.ai', subscriptionType: 'max' } : { loggedIn }));
  process.exit(0);
}
const system = readFileSync(process.argv[process.argv.indexOf('--system-prompt-file') + 1], 'utf8');
const config = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]);
const server = config.mcpServers.pi;
const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
appendFileSync(directory + '/workers.log', JSON.stringify({ cwd: process.cwd(), system, pid: process.pid, helper: mcp.pid }) + '\\n');
const replies = readline.createInterface({ input: mcp.stdout });
const tools = await new Promise((resolve, reject) => {
  mcp.once('exit', (code) => reject(Error('MCP helper exited ' + code)));
  replies.on('line', (line) => { const reply = JSON.parse(line); if (reply.id === 2) resolve(reply.result.tools); });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\\n');
});
writeFileSync(directory + '/mcp-tools.json', JSON.stringify(tools.map((tool) => tool.name)));
const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const send = (value) => console.log(JSON.stringify(value));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { models: [] } } });
    continue;
  }
  if (frame.type !== 'user') continue;
  if (frame.shouldQuery === false) {
    send({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, usage, user_message_uuids: [frame.uuid] });
    continue;
  }
  const answered = frame.message.content.some((block) => block.type === 'tool_result');
  const block = answered
    ? { type: 'text', text: 'Done' }
    : { type: 'tool_use', id: 'tool_write', name: 'mcp__pi__write', input: { path: 'claude.txt', content: 'Written through Claude Code' } };
  const events = [
    { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage } },
    { type: 'content_block_start', index: 0, content_block: answered ? { type: 'text', text: '' } : { ...block, input: {} } },
    { type: 'content_block_delta', index: 0, delta: answered ? { type: 'text_delta', text: 'Done' } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: answered ? 'end_turn' : 'tool_use' }, usage },
    { type: 'message_stop' },
  ];
  for (const event of events) send({ type: 'stream_event', event });
  send({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [block], stop_reason: answered ? 'end_turn' : 'tool_use', usage } });
  send({ type: 'result', subtype: answered ? 'success' : 'error_max_turns', is_error: !answered, num_turns: 1, usage, user_message_uuids: [frame.uuid] });
}
mcp.kill();
`;

/**
 * Writes the fake `claude` executable and its `node` into `bin` (default `directory`); `directory`
 * receives its logs: `invocations.log`, and per worker its cwd, system prompt, pid and tool
 * helper's pid in `workers.log`.
 */
export async function writeFakeClaude(directory: string, bin = directory) {
  const command = join(bin, 'claude');
  await writeFile(command, source(directory));
  await chmod(command, 0o755);
  await symlink(process.execPath, join(bin, 'node'));
  return command;
}

/** A `claude` that can't start, like an npm install whose `node` isn't on PATH. */
export async function writeBrokenClaude(bin: string) {
  const command = join(bin, 'claude');
  await writeFile(command, '#!/usr/bin/env moonbase-missing-node\n');
  await chmod(command, 0o755);
  return command;
}
