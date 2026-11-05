// Loaded with Electron -r before the unchanged built/archive main entry.
const { app, BrowserWindow, clipboard, safeStorage, ipcMain } = require('electron');
const { createCipheriv, createDecipheriv } = require('node:crypto');
const key = Buffer.alloc(32, 116);
safeStorage.isAsyncEncryptionAvailable = async () => true;
safeStorage.encryptStringAsync = async (plain) => {
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.alloc(12, 1));
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
};
safeStorage.decryptStringAsync = async (bytes) => {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.alloc(12, 1));
  decipher.setAuthTag(bytes.subarray(-16));
  return {
    result: Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(),
    shouldReEncrypt: false,
  };
};
const control = (globalThis.integratedTranscript = {
  calls: [],
  copied: [],
  requests: 0,
  beforeMain: !app.isReady() && BrowserWindow.getAllWindows().length === 0,
  streams: [],
  held: null,
  release: null,
});
clipboard.writeText = async (text) => {
  control.copied.push(text);
};
clipboard.read = async () => {
  throw Error('OS clipboard access is disabled');
};
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, listener) =>
  register(name, async (event, input) => {
    if (name === 'moonbase-chat:call')
      control.calls.push({ kind: input.kind, operation: input.operation, backend: input.backend });
    const reply = await listener(event, input);
    if (name === 'moonbase-chat:call' && input.operation === control.held)
      await new Promise((resolve) => {
        control.release = resolve;
      });
    return reply;
  });
const send = (stream, event) =>
  stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
const releases = new WeakMap();
const message = (text) => ({
  id: 'msg_116',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const thought = (text) => ({
  id: 'rs_116',
  type: 'reasoning',
  summary: [{ type: 'summary_text', text }],
});
const complete = (stream, output) => {
  output.forEach((item, output_index) =>
    send(stream, { type: 'response.output_item.done', output_index, item }),
  );
  send(stream, {
    type: 'response.completed',
    response: { id: 'resp_116', status: 'completed', output },
  });
  releases.get(stream)?.();
  stream.close();
};
control.first = () => {
  const stream = control.streams.at(-1);
  send(stream, { type: 'response.created', response: { id: 'resp_116', status: 'in_progress' } });
  send(stream, { type: 'response.output_item.added', output_index: 0, item: thought('') });
  send(stream, { type: 'response.output_item.added', output_index: 1, item: message('') });
  send(stream, {
    type: 'response.reasoning_summary_text.delta',
    output_index: 0,
    delta: 'Local held thought first',
  });
  send(stream, {
    type: 'response.output_text.delta',
    output_index: 1,
    delta: '## Integrated held response\n\nFirst local chunk 🌔',
  });
};
control.next = () => {
  const stream = control.streams.at(-1);
  send(stream, {
    type: 'response.reasoning_summary_text.delta',
    output_index: 0,
    delta: ' and next',
  });
  send(stream, {
    type: 'response.output_text.delta',
    output_index: 1,
    delta: ' and next local chunk',
  });
};
control.finish = () => {
  const stream = control.streams.at(-1);
  const call = {
    id: 'fc_116',
    type: 'function_call',
    call_id: 'image_read_116',
    name: 'read',
    arguments: JSON.stringify({ path: 'retained.png' }),
  };
  send(stream, { type: 'response.output_item.added', output_index: 2, item: call });
  complete(stream, [
    thought('Local held thought first and next'),
    message('## Integrated held response\n\nFirst local chunk 🌔 and next local chunk'),
    call,
  ]);
};
const fetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1') return fetch(input, options);
  if (url.href !== 'https://api.openai.com/v1/responses')
    throw Error('Provider network is disabled');
  const index = ++control.requests;
  let release;
  const body = new ReadableStream({
    start(stream) {
      const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
      const abort = () => {
        release();
        stream.error(new DOMException('Controlled provider aborted', 'AbortError'));
      };
      release = () => signal?.removeEventListener('abort', abort);
      releases.set(stream, release);
      signal?.addEventListener('abort', abort, { once: true });
      if (index === 2) {
        send(stream, { type: 'response.output_item.added', output_index: 0, item: message('') });
        complete(stream, [message('Integrated completed after retained image')]);
      } else control.streams.push(stream);
    },
    cancel() {
      release?.();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
};
