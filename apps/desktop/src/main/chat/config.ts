import { StartupError } from '../startup-errors.ts';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  decodeSshConfiguration,
  SshConfigurationSchema,
  type SshConfiguration,
} from '@moonbase/ssh/configuration';
import type { ChatSession } from '@moonbase/contracts/chat';
import * as Schema from 'effect/Schema';
import { ChatIdentifierSchema } from '@moonbase/contracts/chat-schema';
import { isPrivateTo } from '@moonbase/contracts/files';

const configurationSchema = Schema.Struct({
  profile: SshConfigurationSchema.fields.profile,
  token: Schema.String.check(Schema.isBetweenLength(32, 4096)),
  actorId: ChatIdentifierSchema,
  sshExecutable: Schema.optional(Schema.String.check(Schema.makeFilter(isAbsolute))),
});
const decodeConfiguration = Schema.decodeUnknownSync(configurationSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
export type ChatConfiguration = { ssh: SshConfiguration; context: ChatSession };
export async function readConfiguration(path: string | undefined): Promise<ChatConfiguration> {
  if (!path || !isAbsolute(path)) throw new StartupError({ problem: 'chat-config-path' });
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384 || !isPrivateTo(stat, process.getuid?.()))
      throw new StartupError({ problem: 'chat-config-file' });
    let value: unknown;
    try {
      value = JSON.parse(await file.readFile('utf8'));
    } catch {
      throw new StartupError({ problem: 'chat-config-json' });
    }
    let v: typeof configurationSchema.Type;
    try {
      v = decodeConfiguration(value);
    } catch {
      throw new StartupError({ problem: 'chat-config-invalid' });
    }
    const p = v.profile,
      h = p.expected;
    // Project the private file explicitly; no private extras enter public snapshots or renderer context.
    return {
      ssh: decodeSshConfiguration({
        profile: p,
        token: v.token,
        ...(v.sshExecutable ? { sshExecutable: v.sshExecutable } : {}),
      }),
      context: { host: { hostId: h.hostId, storeId: h.storeId }, actorId: v.actorId },
    };
  } finally {
    await file.close();
  }
}
