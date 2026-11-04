import type { ChatTarget } from '@moonbase/contracts/chat';
import type { AddressInfo } from 'node:net';
import type * as Esbuild from 'esbuild';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { checkHostHealth } from '@moonbase/ssh/host-health';
import { ConnectionService } from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { RemoteChatLive } from '../src/remote.ts';
import { createRequire } from 'node:module';

async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Child did not settle.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function port() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const value = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return value;
}
function start(path: string, fixture = false) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      new URL('./no-provider.mjs', import.meta.url).pathname,
      '--experimental-strip-types',
      new URL(fixture ? './faux-host.mjs' : '../src/host.ts', import.meta.url).pathname,
      path,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENAI_API_KEY: 'synthetic-no-provider-requests' },
    },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (errors += b));
  const exited = once(child, 'exit');
  const ready = new Promise<void>((resolve, reject) => {
    const data = () => {
      if (output.includes('"event":"ready"')) {
        child.stdout.off('data', data);
        resolve();
      }
    };
    child.stdout.on('data', data);
    child.once('exit', () => reject(Error('Host exited before ready: ' + errors)));
  });
  ready.catch(() => {});
  return {
    child,
    exited,
    ready,
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
  };
}
async function cleanup(child: ChildProcess, exited: Promise<unknown>) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await bounded(exited).catch(async () => {
    child.kill('SIGKILL');
    await bounded(exited);
  });
}
test('actual standalone CLI owns one SQLite store before serving, releases on shutdown and recovers after SIGKILL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moonbase-chat-host-')),
    token = randomBytes(32).toString('base64url'),
    host = { hostId: 'child-host', storeId: 'child-store' },
    listen = await port(),
    file = join(dir, 'private.json');
  const config = {
    host,
    actorId: 'personal',
    cwd: dir,
    databasePath: join(dir, 'chat.sqlite'),
    model: { provider: 'openai', modelId: 'gpt-6-sol' },
    port: listen,
    token,
  };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const children: ReturnType<typeof start>[] = [];
  try {
    const owner = start(file);
    children.push(owner);
    await bounded(owner.ready);
    const health = await Effect.runPromise(
      checkHostHealth({ origin: `http://127.0.0.1:${listen}`, token, expected: host }),
    );
    assert.equal(health.hostId, host.hostId);
    assert(!owner.output.includes(token));
    assert(!owner.errors.includes(token));
    const alternate = join(dir, 'alternate.json');
    await writeFile(alternate, JSON.stringify({ ...config, port: await port() }), { mode: 0o600 });
    const contender = start(alternate);
    children.push(contender);
    assert.equal((await bounded(contender.exited))[0], 1);
    assert(!contender.output.includes('ready'));
    assert(!contender.errors.includes(dir));
    owner.child.kill('SIGKILL');
    assert.equal((await bounded(owner.exited))[1], 'SIGKILL');
    const recovered = start(file);
    children.push(recovered);
    await bounded(recovered.ready);
    recovered.child.kill('SIGTERM');
    assert.equal((await bounded(recovered.exited))[0], 0);
    const again = start(file);
    children.push(again);
    await bounded(again.ready);
    again.child.kill('SIGTERM');
    assert.equal((await bounded(again.exited))[0], 0);
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(listen, '127.0.0.1', () => server.close(() => resolve()));
    });
  } finally {
    await Promise.all(children.map((c) => cleanup(c.child, c.exited)));
    await rm(dir, { recursive: true, force: true });
  }
});
test('CLI rejects malformed private config without echoing secrets or file paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moonbase-chat-bad-')),
    file = join(dir, 'private.json'),
    secret = randomBytes(32).toString('hex');
  await writeFile(file, '{' + secret);
  const child = start(file);
  try {
    assert.equal((await bounded(child.exited))[0], 1);
    assert(!child.errors.includes(secret));
    assert(!child.errors.includes(file));
  } finally {
    await cleanup(child.child, child.exited);
    await rm(dir, { recursive: true, force: true });
  }
});

test('actual child host crash resumes Pi-owned work without resubmitting reserved application input or replaying the counted unsafe tool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-pi-resume-')),
    listen = await port(),
    host = { hostId: 'resumable', storeId: 'store' },
    token = randomBytes(32).toString('base64url'),
    file = join(directory, 'private.json'),
    log = join(directory, 'effects.jsonl');
  const config = {
    host,
    actorId: 'personal',
    cwd: directory,
    databasePath: join(directory, 'chat.sqlite'),
    port: listen,
    token,
    log,
  };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const unavailable = () =>
    Effect.fail(
      new ApplicationError({ code: 'Unavailable', message: 'Not a connection command.' }),
    );
  const runtime = ManagedRuntime.make(
    RemoteChatLive.pipe(
      Layer.provide(
        Layer.succeed(ConnectionService, {
          getConnection: unavailable,
          connect: unavailable,
          disconnect: unavailable,
          watch: () => Stream.empty,
          endpoint: () =>
            Effect.succeed({
              origin: `http://127.0.0.1:${listen}`,
              token,
              expected: host,
              connectionId: 'controlled',
              health: { ...host, protocol: 1, version: '0.1.0', capabilities: ['chat-v0'] },
            }),
        }),
      ),
    ),
  );
  const client = makeChatClient(runtime),
    children: ReturnType<typeof start>[] = [],
    rows = async () => {
      try {
        return (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event: string });
      } catch {
        return [];
      }
    };
  try {
    const first = start(file, true);
    children.push(first);
    await bounded(first.ready);
    const session = { host, actorId: 'personal' },
      target = (
        await client.command('createChat', { session, requestId: 'create', title: 'Crash resume' })
      ).conversation.target;
    const receipt = await client.command('sendChat', {
      target,
      requestId: 'original',
      text: 'One original input',
    });
    for (let i = 0; i < 300 && !(await rows()).some((r) => r.event === 'tool'); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal((await rows()).filter((r) => r.event === 'tool').length, 1);
    first.child.kill('SIGKILL');
    await bounded(first.exited);
    const resumed = start(file, true);
    children.push(resumed);
    await bounded(resumed.ready);
    assert.deepEqual(
      await client.command('getChatSend', { target, requestId: 'original' }),
      receipt,
    );
    let completed = false;
    for (let i = 0; i < 300; i++) {
      const snapshot = await client.command('getChat', { target });
      if (!snapshot.run && snapshot.entries.some((e) => e.text === 'Resumed original input')) {
        completed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(completed, 'Pi did not resume its admitted task');
    assert.equal((await rows()).filter((r) => r.event === 'tool').length, 1);
    assert.equal((await rows()).filter((r) => r.event === 'model').length, 2);
    assert.equal(
      (await client.command('getChat', { target })).entries.filter((e) => e.role === 'user').length,
      1,
    );
  } finally {
    await runtime.dispose();
    await Promise.all(children.map((c) => cleanup(c.child, c.exited)));
    await rm(directory, { recursive: true, force: true });
  }
});

test('compiled remote entry runs on Electron Node24 against the separate Node26 production host with no engine graph', async () => {
  const rootRequire = createRequire(new URL('../../../package.json', import.meta.url)),
    esbuild = rootRequire('esbuild') as typeof Esbuild,
    electron = rootRequire('electron') as string;
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-electron-remote-')),
    listen = await port(),
    host = { hostId: 'electron-remote', storeId: 'store' },
    token = randomBytes(32).toString('base64url'),
    file = join(directory, 'private.json');
  const config = {
    host,
    actorId: 'personal',
    cwd: directory,
    databasePath: join(directory, 'chat.sqlite'),
    port: listen,
    token,
    log: join(directory, 'effects'),
  };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const entry = join(directory, 'remote.cjs');
  const source = `import {readFileSync} from 'node:fs';
    import {Effect,Layer,ManagedRuntime,Stream} from 'effect';
    import { ConnectionService } from '@moonbase/contracts/services';
    import {makeChatClient} from '@moonbase/application/runtime/clients';
    import {RemoteChatLive} from './src/remote.ts';
    async function main(){
      const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
      const unavailable=()=>Effect.die('No implicit connection command');
      const connection=Layer.succeed(ConnectionService,{getConnection:unavailable,connect:unavailable,disconnect:unavailable,watch:()=>Stream.empty,endpoint:()=>Effect.succeed({origin:'http://127.0.0.1:'+config.port,token:config.token,expected:config.host,connectionId:'controlled',health:{...config.host,protocol:1,version:'0.1.0',capabilities:['chat-v0']}})});
      const runtime=ManagedRuntime.make(RemoteChatLive.pipe(Layer.provide(connection))),client=makeChatClient(runtime);
      try{const publicHost=await client.command('getChatHost',{host:config.host});const target=(await client.command('createChat',{session:{host:config.host,actorId:'personal'},requestId:'electron-create',title:'Electron remote'})).conversation.target;
        if(!publicHost.features?.includes('chat-stream-v1'))throw Error('stream feature missing');
        let off; await boundedWatch();
        async function boundedWatch(){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('stream deadline')),4000);off=client.watch({target},value=>{if(value.observationStatus==='connected'){clearTimeout(timer);resolve();}},reject);});await off();}
        const receipt=await client.command('sendChat',{target,requestId:'electron-send',text:'One controlled input'});
        const recovered=await client.command('getChatSend',{target,requestId:'electron-send'});
        if(JSON.stringify(receipt)!==JSON.stringify(recovered))throw Error('receipt mismatch');
        console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,publicHost,admission:recovered.admission}));
      }finally{await runtime.dispose();}}
    main().catch(()=>{console.error('remote compatibility failed');process.exitCode=1;});`;
  const result = await esbuild.build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: entry,
    metafile: true,
  });
  const inputs = Object.keys(result.metafile!.inputs).map((path) => resolve(path));
  assert(
    !inputs.some((path) =>
      /pi-durable|pi-ai|chord|packages\/(workspace|workbench|editor)\//.test(path),
    ),
  );
  const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
  assert.deepEqual(
    inputs.filter((path) => path.startsWith(sourceDirectory)).sort(),
    ['remote.ts', 'protocol.ts', 'validation.ts'].map((name) => join(sourceDirectory, name)).sort(),
    'The remote bundle must contain only its transport, protocol and validation leaves.',
  );
  assert(
    !Object.values(result.metafile!.outputs).some((output) =>
      output.imports.some((value) => value.path === 'node:sqlite'),
    ),
  );
  const server = start(file, true);
  let child: ChildProcess | undefined, exited: Promise<unknown> | undefined;
  try {
    await bounded(server.ready);
    child = spawn(electron, [entry, file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let output = '',
      errors = '';
    child.stdout!.on('data', (b) => (output += b));
    child.stderr!.on('data', (b) => (errors += b));
    exited = once(child, 'exit');
    assert.equal(((await bounded(exited)) as unknown[])[0], 0, errors);
    const record = JSON.parse(output.trim());
    assert.equal(record.node, '24.22.1');
    assert.equal(record.electron, '45.1.0');
    assert.equal(record.admission, 'admitted');
    assert(!output.includes(token));
    assert(!errors.includes(token));
  } finally {
    if (child && exited) await cleanup(child, exited);
    await cleanup(server.child, server.exited);
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeated actual process interruption parks Pi work visibly instead of reporting healthy idle/running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-pi-parked-')),
    listen = await port(),
    host = { hostId: 'parked', storeId: 'store' },
    token = randomBytes(32).toString('base64url'),
    file = join(directory, 'private.json'),
    log = join(directory, 'effects');
  await writeFile(
    file,
    JSON.stringify({
      host,
      actorId: 'personal',
      cwd: directory,
      databasePath: join(directory, 'chat.sqlite'),
      port: listen,
      token,
      log,
      modelWait: true,
    }),
    { mode: 0o600 },
  );
  const unavailable = () => Effect.die('No implicit connection');
  const runtime = ManagedRuntime.make(
    RemoteChatLive.pipe(
      Layer.provide(
        Layer.succeed(ConnectionService, {
          getConnection: unavailable,
          connect: unavailable,
          disconnect: unavailable,
          watch: () => Stream.empty,
          endpoint: () =>
            Effect.succeed({
              origin: `http://127.0.0.1:${listen}`,
              token,
              expected: host,
              connectionId: 'controlled',
              health: { ...host, protocol: 1, version: '0.1.0', capabilities: ['chat-v0'] },
            }),
        }),
      ),
    ),
  );
  const client = makeChatClient(runtime),
    children: ReturnType<typeof start>[] = [];
  let target: ChatTarget | undefined;
  try {
    let parked = false;
    for (let i = 0; i < 7; i++) {
      const child = start(file, true);
      children.push(child);
      await bounded(child.ready);
      if (!target) {
        target = (
          await client.command('createChat', {
            session: { host, actorId: 'personal' },
            requestId: 'create',
            title: 'Park safely',
          })
        ).conversation.target;
        await client.command('sendChat', { target, requestId: 'original', text: 'One input' });
      }
      await new Promise((r) => setTimeout(r, 75));
      const snapshot = await client.command('getChat', { target });
      if (snapshot.state === 'failed') {
        assert.match(snapshot.message ?? '', /parked/i);
        assert(snapshot.run);
        assert.equal(snapshot.entries.filter((e) => e.role === 'user').length, 1);
        parked = true;
        break;
      }
      assert.equal(snapshot.state, 'running');
      child.child.kill('SIGKILL');
      await bounded(child.exited);
    }
    assert(parked, 'Repeated crashes never surfaced Pi parking');
  } finally {
    await runtime.dispose();
    await Promise.all(children.map((c) => cleanup(c.child, c.exited)));
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI rejects strict private configuration before opening or rewriting its store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-chat-strict-')),
    file = join(directory, 'private.json'),
    secret = randomBytes(32).toString('hex');
  const config = {
    host: { hostId: 'strict-host', storeId: 'store' },
    actorId: 'personal',
    cwd: directory,
    databasePath: join(directory, 'chat.sqlite'),
    model: { provider: 'openai', modelId: 'gpt-6-sol' },
    token: secret,
    port: 8787,
  };
  try {
    for (const change of [
      { future: secret },
      { host: { ...config.host, future: secret } },
      { model: { ...config.model, future: secret } },
      { model: { ...config.model, modelId: 'x'.repeat(257) } },
      { cwd: 'relative-' + secret },
      { port: 0 },
      { port: 65536 },
      { token: secret + ' ' },
    ]) {
      const bytes = JSON.stringify({ ...config, ...change });
      await writeFile(file, bytes, { mode: 0o600 });
      const child = start(file);
      try {
        assert.equal((await bounded(child.exited))[0], 1);
        assert(child.errors.includes('InvalidInput'));
        assert(!child.errors.includes(secret));
        assert(!child.errors.includes(directory));
        assert.equal(await readFile(file, 'utf8'), bytes);
        await assert.rejects(readFile(config.databasePath), { code: 'ENOENT' });
      } finally {
        await cleanup(child.child, child.exited);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
