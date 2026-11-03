import * as Schema from 'effect/Schema';
import { struct } from './schema.ts';
import { ChatIdentifierSchema } from './chat-schema.ts';
import { ApplicationError } from './errors.ts';
import type { ProviderCommand, ProviderInput, ProviderOutput } from './providers.ts';

const text = (limit: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        !/[\ud800-\udfff]/u.test(value) &&
        !value.includes('\0') &&
        new TextEncoder().encode(value).length <= limit,
    ),
  );
const option = struct({ id: text(256), label: text(512) });
export const ProviderStateSchema = struct({
  providers: Schema.mutable(
    Schema.Array(
      struct({
        id: ChatIdentifierSchema,
        name: text(128),
        auth: Schema.Literals(['oauth', 'api_key']),
        configured: Schema.Boolean,
        models: Schema.mutable(Schema.Array(struct({ modelId: text(256), name: text(256) }))).check(
          Schema.isMaxLength(4096),
        ),
      }),
    ),
  ).check(Schema.isMaxLength(5)),
  flow: Schema.NullOr(
    struct({
      id: ChatIdentifierSchema,
      providerId: ChatIdentifierSchema,
      state: Schema.Literals(['running', 'completed', 'cancelled', 'failed']),
      message: text(512),
      canOpenUrl: Schema.Boolean,
      prompt: Schema.NullOr(
        struct({
          id: ChatIdentifierSchema,
          type: Schema.Literals(['text', 'secret', 'select', 'manual_code']),
          message: text(512),
          options: Schema.mutable(Schema.Array(option)).check(Schema.isMaxLength(32)),
        }),
      ),
    }),
  ),
});
export const providerInputSchemas = {
  getProviders: struct({}),
  startProviderLogin: struct({ providerId: ChatIdentifierSchema }),
  answerProviderPrompt: struct({
    flowId: ChatIdentifierSchema,
    promptId: ChatIdentifierSchema,
    answer: text(16384),
  }),
  cancelProviderLogin: struct({ flowId: ChatIdentifierSchema }),
  openProviderUrl: struct({ flowId: ChatIdentifierSchema }),
  logoutProvider: struct({ providerId: ChatIdentifierSchema }),
};
export const isProviderCommand = (value: unknown): value is ProviderCommand =>
  typeof value === 'string' && Object.hasOwn(providerInputSchemas, value);
export function decodeProviderInput<K extends ProviderCommand>(
  operation: K,
  value: unknown,
): ProviderInput<K> {
  try {
    if (!isProviderCommand(operation)) throw Error();
    return Schema.decodeUnknownSync(providerInputSchemas[operation], {
      onExcessProperty: 'error',
      reportInput: false,
    })(value) as ProviderInput<K>;
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid provider setup input.' });
  }
}
export function decodeProviderOutput<K extends ProviderCommand>(
  _operation: K,
  value: unknown,
): ProviderOutput<K> {
  try {
    return Schema.decodeUnknownSync(ProviderStateSchema, {
      onExcessProperty: 'ignore',
      reportInput: false,
    })(value);
  } catch {
    throw new ApplicationError({ code: 'Incompatible', message: 'Invalid provider setup reply.' });
  }
}
