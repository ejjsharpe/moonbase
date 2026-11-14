import * as Schema from 'effect/Schema';
import { fail } from '@moonbase/contracts/errors';
import { AbsolutePathSchema as absolutePath } from '@moonbase/contracts/daemon-schema';

const port = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0 && value <= 65535),
);
const keyFile = Schema.Struct({ source: Schema.Literal('file'), path: absolutePath });
// A root is named by its real path; one under another would only repeat its folders.
const approvedRoots = Schema.Array(absolutePath).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.makeFilter((roots) =>
    roots.every(
      (root, index) =>
        !/(?:^|\/)\.\.?(?:\/|$)|\/\/|.\/$/.test(root) &&
        roots.every(
          (other, at) =>
            at === index || (other !== root && !root.startsWith(other === '/' ? '/' : `${other}/`)),
        ),
    ),
  ),
);
const DaemonSettingsSchema = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal('local'),
    credentialKey: Schema.optional(
      Schema.Union([Schema.Struct({ source: Schema.Literal('keychain') }), keyFile]),
    ),
  }),
  Schema.Struct({
    mode: Schema.Literal('host'),
    port,
    approvedRoots,
    // Without a GUI session the login keychain is usually locked, so a host uses a key file.
    credentialKey: keyFile,
  }),
]);

/**
 * A daemon's optional `daemon.json`: a local-mode daemon (the default) with the source of its
 * credential key, or a host-mode daemon with its port, approved roots and credential key file.
 */
export type DaemonSettings = typeof DaemonSettingsSchema.Type;
const decode = Schema.decodeUnknownSync(DaemonSettingsSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
/** Decodes `daemon.json` strictly; unknown fields are refused, and errors name no input. */
export function decodeDaemonSettings(value: unknown): DaemonSettings {
  try {
    return decode(value);
  } catch {
    return fail('InvalidInput', 'Invalid daemon settings.');
  }
}
