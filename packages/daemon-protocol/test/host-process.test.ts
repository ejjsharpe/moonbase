import type { ChatTarget } from '@moonbase/contracts/chat';
import type { AddressInfo } from 'node:net';
import type * as Esbuild from 'esbuild';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
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
/** The model the controlled host (`faux-host.mjs`) installs. */
const model = { provider: 'faux-host', modelId: 'faux-model' };
/**
 * Starts the controlled local-mode host (`faux-host.mjs`) on the suite's runtime. Remote hosts
 * themselves run the daemon, whose own suite covers its process; these cases cover the server and
 * the remote client across a real process boundary.
 */
function start(path: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      new URL('./no-provider.mjs', import.meta.url).pathname,
      '--experimental-strip-types',
      new URL('./faux-host.mjs', import.meta.url).pathname,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
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
test('actual child host crash resumes Pi-owned work without resubmitting reserved application input or replaying the counted unsafe tool', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-pi-resume-'))),
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
              health: {
                ...host,
                protocol: 2,
                version: '0.1.0',
                capabilities: ['chat-v0', 'daemon-local-v1'],
              },
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
    const first = start(file);
    children.push(first);
    await bounded(first.ready);
    const session = { host, actorId: 'personal' },
      target = (
        await client.command('createChat', {
          session,
          requestId: 'create',
          title: 'Crash resume',
          settings: { cwd: directory, model },
        })
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
    const resumed = start(file);
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

test('compiled remote entry runs on Electron Node24 against the separate production host with no engine graph', async () => {
  const rootRequire = createRequire(new URL('../../../package.json', import.meta.url)),
    esbuild = rootRequire('esbuild') as typeof Esbuild,
    electron = rootRequire('electron') as string;
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-electron-remote-'))),
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
    model,
  };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const entry = join(directory, 'remote.cjs');
  const source = `import {readFileSync} from 'node:fs';
    import {Effect,Layer,ManagedRuntime,Stream} from 'effect';
    import { ConnectionService, LocalHostService } from '@moonbase/contracts/services';
    import {makeChatClient} from '@moonbase/application/runtime/clients';
    import {RemoteChatLive} from './src/remote.ts';
    async function main(){
      const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
      const unavailable=()=>Effect.die('No implicit connection command');
      const connection=Layer.succeed(ConnectionService,{getConnection:unavailable,connect:unavailable,disconnect:unavailable,watch:()=>Stream.empty,endpoint:()=>Effect.succeed({origin:'http://127.0.0.1:'+config.port,token:config.token,expected:config.host,connectionId:'controlled',health:{...config.host,protocol:2,version:'0.1.0',capabilities:['chat-v0','daemon-local-v1']}})});
      const runtime=ManagedRuntime.make(RemoteChatLive.pipe(Layer.provide(connection))),client=makeChatClient(runtime);
      try{const publicHost=await client.command('getChatHost',{host:config.host});const target=(await client.command('createChat',{session:{host:config.host,actorId:'personal'},requestId:'electron-create',title:'Electron remote',settings:{cwd:config.cwd,model:config.model}})).conversation.target;
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
      /pi-durable|pi-ai|chord|packages\/(chat-runtime|workspace|workbench|editor)\//.test(path),
    ),
  );
  const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
  assert.deepEqual(
    inputs.filter((path) => path.startsWith(sourceDirectory)).sort(),
    ['remote.ts', 'protocol.ts', 'socket-client.ts', 'socket-protocol.ts']
      .map((name) => join(sourceDirectory, name))
      .sort(),
    'The remote bundle must contain only its transport and protocol leaves.',
  );
  assert(
    !Object.values(result.metafile!.outputs).some((output) =>
      output.imports.some((value) => value.path === 'node:sqlite'),
    ),
  );
  const server = start(file);
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
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-pi-parked-'))),
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
              health: {
                ...host,
                protocol: 2,
                version: '0.1.0',
                capabilities: ['chat-v0', 'daemon-local-v1'],
              },
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
      const child = start(file);
      children.push(child);
      await bounded(child.ready);
      if (!target) {
        target = (
          await client.command('createChat', {
            session: { host, actorId: 'personal' },
            requestId: 'create',
            title: 'Park safely',
            settings: { cwd: directory, model },
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
