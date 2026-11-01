import { readFileSync } from 'node:fs';
import { ManagedRuntime } from 'effect';
import { makeConnectionClient } from '@moonbase/application/runtime-client';
import { SshLive, type SshConfiguration } from '@moonbase/ssh';

// This executable is a consumer composition root, not a runtime inside the feature service.
const file = process.argv[2];
if (!file) throw Error('Supply an explicit private SSH connection configuration JSON file.');
let configuration: SshConfiguration;
try {
  configuration = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  throw Error('Could not read the private connection configuration JSON.');
}
const runtime = ManagedRuntime.make(SshLive(configuration));
const client = makeConnectionClient(runtime);
let stop = () => {};
try {
  stop = client.watch(
    (snapshot) => console.log(JSON.stringify(snapshot)),
    (error) => console.error(error.message),
  );
  const snapshot = await client.command('connect', { profileId: configuration.profile.id });
  if (snapshot.state !== 'connected') throw Error('Connection did not verify.');
  await client.command('disconnect', { connectionId: snapshot.connectionId });
} finally {
  stop();
  await runtime.dispose();
}
