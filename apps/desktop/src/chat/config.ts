import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { SshConfiguration } from '@moonbase/ssh';
import type { ChatSession } from '@moonbase/application/chat-client';
import { fields, record, requestId, invalid } from './wire.ts';
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
    const v = record(value);
    fields(v, ['profile', 'token', 'actorId', 'sshExecutable'], ['profile', 'token', 'actorId']);
    requestId(v.actorId);
    const p = record(v.profile);
    fields(p, ['id', 'label', 'destination', 'remotePort', 'expected']);
    const h = record(p.expected);
    fields(h, ['hostId', 'storeId']);
    requestId(h.hostId);
    requestId(h.storeId);
    if (
      typeof v.token !== 'string' ||
      v.token.length < 32 ||
      v.token.length > 4096 ||
      typeof p.label !== 'string' ||
      typeof p.destination !== 'string' ||
      typeof p.remotePort !== 'number' ||
      (v.sshExecutable !== undefined &&
        (typeof v.sshExecutable !== 'string' || !isAbsolute(v.sshExecutable)))
    )
      return invalid();
    requestId(p.id);
    // Project the private file explicitly; no private extras enter public snapshots or renderer context.
    return {
      ssh: {
        profile: {
          id: p.id,
          label: p.label,
          destination: p.destination,
          remotePort: p.remotePort,
          expected: { hostId: h.hostId, storeId: h.storeId },
        },
        token: v.token,
        ...(v.sshExecutable ? { sshExecutable: v.sshExecutable as string } : {}),
      },
      context: { host: { hostId: h.hostId, storeId: h.storeId }, actorId: v.actorId },
    };
  } finally {
    await file.close();
  }
}
