import * as Schema from 'effect/Schema';

const problems = {
  'user-data-path': 'Set MOONBASE_USER_DATA to an explicit new Moonbase user-data directory.',
  'user-data': 'The Moonbase user-data directory is unavailable.',
  'chat-config-path': 'Set MOONBASE_CHAT_CONFIG to an absolute private configuration file.',
  'chat-config-file': 'Chat configuration must be an owner-only regular file, at most 16 KiB.',
  'chat-config-json': 'Chat configuration is not valid JSON.',
  'chat-config-invalid': 'Invalid chat request.',
  'chat-config-unreadable': 'The chat configuration is unreadable.',
  recovery: 'Recovery is unavailable.',
} as const;
/** Electron main could not start, for `problem`: what it needs from its environment or profile. */
export class StartupError extends Schema.TaggedError<StartupError>()('StartupError', {
  problem: Schema.Literals(Object.keys(problems) as [keyof typeof problems]),
}) {
  override get message(): string {
    return problems[this.problem];
  }
}
