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
import { Effect } from 'effect';
import * as Schema from 'effect/Schema';
import { ChatIdentifierSchema } from '@moonbase/contracts/chat-schema';
import { isPrivateTo } from '@moonbase/contracts/files';

const configurationSchema = Schema.Struct({
  profile: SshConfigurationSchema.fields.profile,
  token: Schema.String.check(Schema.isBetweenLength(32, 4096)),
  actorId: ChatIdentifierSchema,
  sshExecutable: Schema.optional(Schema.String.check(Schema.makeFilter(isAbsolute))),
});
const decodeConfiguration = Schema.decodeUnknownEffect(configurationSchema, {
  onExcessProperty: 'error',
});
export type ChatConfiguration = { ssh: SshConfiguration; context: ChatSession };
const unreadable = () => new StartupError({ problem: 'chat-config-unreadable' });
/**
 * The chat configuration at `path`: an owner-only regular file of at most 16 KiB, read through one
 * no-follow descriptor. A refusal names what is wrong, never the file's contents.
 */
export const readConfiguration = (
  path: string | undefined,
): Effect.Effect<ChatConfiguration, StartupError> =>
  Effect.gen(function* () {
    if (!path || !isAbsolute(path)) return yield* new StartupError({ problem: 'chat-config-path' });
    const file = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
        catch: unreadable,
      }),
      (file) => Effect.ignore(Effect.tryPromise(() => file.close())),
    );
    const stat = yield* Effect.tryPromise({ try: () => file.stat(), catch: unreadable });
    if (!stat.isFile() || stat.size > 16384 || !isPrivateTo(stat, process.getuid?.()))
      return yield* new StartupError({ problem: 'chat-config-file' });
    const text = yield* Effect.tryPromise({ try: () => file.readFile('utf8'), catch: unreadable });
    const value = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new StartupError({ problem: 'chat-config-json' }),
    });
    const v = yield* decodeConfiguration(value).pipe(
      Effect.mapError(() => new StartupError({ problem: 'chat-config-invalid' })),
    );
    const p = v.profile,
      h = p.expected;
    // Project the private file explicitly; no private extras enter public snapshots or renderer context.
    const ssh = yield* decodeSshConfiguration({
      profile: p,
      token: v.token,
      ...(v.sshExecutable ? { sshExecutable: v.sshExecutable } : {}),
    }).pipe(Effect.mapError(unreadable));
    return { ssh, context: { host: { hostId: h.hostId, storeId: h.storeId }, actorId: v.actorId } };
  }).pipe(Effect.scoped);
