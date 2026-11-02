import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  decodeSshConfiguration,
  SshConfigurationSchema,
  type SshConfiguration,
} from '@moonbase/ssh/configuration';
import type { ChatSession } from '@moonbase/application/chat-client';
import * as Schema from 'effect/Schema';
import { ChatIdentifierSchema } from '@moonbase/application/chat-schema';
import { invalid } from './wire.ts';

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
  if (!path || !isAbsolute(path))
    throw Error('Set MOONBASE_CHAT_CONFIG to an absolute private configuration file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 16384 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw Error('Chat configuration must be an owner-only regular file, at most 16 KiB.');
    let value: unknown;
    try {
      value = JSON.parse(await file.readFile('utf8'));
    } catch {
      throw Error('Chat configuration is not valid JSON.');
    }
    let v: typeof configurationSchema.Type;
    try {
      v = decodeConfiguration(value);
    } catch {
      return invalid();
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
