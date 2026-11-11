import { Effect, Schema, SchemaGetter } from 'effect';
import { isAbsolute } from 'node:path';
import { ApplicationError } from '@moonbase/contracts/workspace';
import {
  ConnectionPortSchema,
  ConnectionProfileSchema,
} from '@moonbase/contracts/connection-schema';

const executable = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.makeFilter((value) => isAbsolute(value) && !value.includes('\0'))),
    {
      decode: SchemaGetter.transform((value) => value ?? '/usr/bin/ssh'),
      encode: SchemaGetter.passthrough(),
    },
  ),
  Schema.withDecodingDefault(Effect.succeed(null)),
);

export const SshConfigurationSchema = Schema.Struct({
  // SSH forwards to the host's port, so its profile must name one.
  profile: Schema.mutableKey(
    ConnectionProfileSchema.mapFields((fields) => ({
      ...fields,
      remotePort: Schema.mutableKey(ConnectionPortSchema),
    })),
  ),
  token: Schema.mutableKey(Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{16,4096}$/))),
  sshExecutable: Schema.mutableKey(executable),
}).check(
  Schema.makeFilter(
    ({ profile, token, sshExecutable }) =>
      ![
        profile.id,
        profile.label,
        profile.destination,
        profile.expected.hostId,
        profile.expected.storeId,
        sshExecutable,
      ].some((value) => value.includes(token)),
  ),
);

export type DecodedSshConfiguration = typeof SshConfigurationSchema.Type;
export type SshConfiguration = Omit<DecodedSshConfiguration, 'sshExecutable'> & {
  sshExecutable?: string;
};

const decode = Schema.decodeUnknownSync(SshConfigurationSchema, { reportInput: false });
export function decodeSshConfiguration(value: unknown): DecodedSshConfiguration {
  try {
    return decode(value);
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid SSH configuration.' });
  }
}
