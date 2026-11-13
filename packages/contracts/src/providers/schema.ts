import type { CommandOptions, ObservationClose } from '../shared/common.ts';
import { ApplicationError } from '../errors/schema.ts';
import * as Schema from 'effect/Schema';
import { struct, optional } from '../shared/schema.ts';
import {
  ChatIdentifierSchema,
  ChatModelPreferenceSchema,
  ChatReasoningEffortSchema,
} from '../chat/schema.ts';

export type ProviderState = typeof ProviderStateSchema.Type;
export type ProviderCommand = keyof typeof providerInputSchemas;
export type ProviderInput<K extends ProviderCommand> = (typeof providerInputSchemas)[K]['Type'];
export type ProviderOutput<_K extends ProviderCommand> = ProviderState;
export interface ProviderSetupClient {
  command<K extends ProviderCommand>(
    operation: K,
    input: ProviderInput<K>,
    options?: CommandOptions,
  ): Promise<ProviderOutput<K>>;
  /** The setup state, then again after each change to it, so a sign-in's progress needs no polling. */
  watch(
    receive: (state: ProviderState) => void,
    onError: (error: ApplicationError) => void,
  ): ObservationClose;
}

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
        auth: Schema.Literals(['oauth', 'api_key', 'claude_code']),
        configured: Schema.Boolean,
        /** Why the provider's check couldn't tell whether it is configured, e.g. a CLI that won't start. */
        problem: optional(text(512)),
        defaultModel: optional(ChatModelPreferenceSchema),
        models: Schema.mutable(
          Schema.Array(
            struct({
              modelId: text(256),
              name: text(256),
              reasoningEfforts: optional(
                Schema.mutable(Schema.Array(ChatReasoningEffortSchema)).check(
                  Schema.isMaxLength(7),
                ),
              ),
              defaultReasoningEffort: optional(ChatReasoningEffortSchema),
            }),
          ),
        ).check(Schema.isMaxLength(4096)),
      }),
    ),
  ).check(Schema.isMaxLength(6)),
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
/** Origins a provider's sign-in page may be on; anything else never reaches a client or browser. */
export const providerSignInOrigins = ['https://auth.openai.com'] as const;
/** The normalized sign-in URL, when it is an https page on a provider's sign-in origin with no credentials. */
export function readProviderSignInUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(providerSignInOrigins as readonly string[]).includes(url.origin)
  )
    return undefined;
  return url.href;
}
export const ProviderSignInUrlSchema = Schema.String.check(
  Schema.makeFilter((value) => readProviderSignInUrl(value) === value),
);
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
