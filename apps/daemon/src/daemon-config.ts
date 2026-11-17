import { Config, ConfigProvider, Duration, Effect, Schema } from 'effect';
import { DaemonConfigurationError } from './daemon-errors.ts';

/**
 * What the daemon reads from its `ConfigProvider`: its arguments, of which the one it takes is the
 * data directory, and how long its waits are. Everything else is read from files inside the
 * data directory (`daemon-settings.ts`), which are decoded strictly as the private files they are.
 */
const DaemonConfigSchema = Config.all({
  arguments: Config.schema(Schema.Array(Schema.String), 'arguments').pipe(Config.withDefault([])),
  /** A local daemon exits after this long unused. */
  idle: Config.Duration('idle').pipe(Config.withDefault(Duration.minutes(5))),
  /** How often an otherwise unused local daemon checks for active work. */
  poll: Config.Duration('poll').pipe(Config.withDefault(Duration.seconds(30))),
  /** How long shutdown waits for the workspace to close before going on without it. */
  workspaceClose: Config.Duration('workspaceClose').pipe(Config.withDefault(Duration.seconds(5))),
  /** How long shutdown then waits for the server's mutations still running. */
  serverClose: Config.Duration('serverClose').pipe(Config.withDefault(Duration.seconds(5))),
});
export type DaemonConfig = Omit<Config.Success<typeof DaemonConfigSchema>, 'arguments'> & {
  /** The data directory, as given; checked when it is opened. */
  directory: string;
};

/** Reads the daemon's config; more than one argument, or a value it can't read, is refused. */
export const readDaemonConfig: Effect.Effect<DaemonConfig, DaemonConfigurationError> = Effect.gen(
  function* () {
    const { arguments: args, ...config } = yield* Effect.mapError(
      DaemonConfigSchema,
      () => new DaemonConfigurationError({ problem: 'settings' }),
    );
    if (args.length > 1) return yield* new DaemonConfigurationError({ problem: 'arguments' });
    return { ...config, directory: args[0] ?? '' };
  },
);

/**
 * The daemon's config from its process: its arguments, and nothing from the environment, so
 * launchd can start it unchanged.
 */
export const argumentsConfig = (args: readonly string[], values: Record<string, string> = {}) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ ...values, arguments: args }));
