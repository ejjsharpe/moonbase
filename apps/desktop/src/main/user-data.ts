import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { App } from 'electron';
import { Effect } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';

/**
 * The profile's user-data directory, made private if new: `MOONBASE_USER_DATA`, or the packaged
 * app's own. Electron keeps its state there too, so it is set before Electron is ready, which is
 * why this runs synchronously.
 */
export const prepareUserData = (app: Pick<App, 'isPackaged' | 'getPath' | 'setPath'>) =>
  Effect.try({
    try: () => {
      const requested =
        process.env.MOONBASE_USER_DATA ??
        (app.isPackaged ? join(app.getPath('appData'), 'Moonbase') : undefined);
      if (!requested || !isAbsolute(requested))
        throw new ApplicationError({
          code: 'InvalidInput',
          message: 'Set MOONBASE_USER_DATA to an explicit new Moonbase user-data directory.',
        });
      mkdirSync(requested, { recursive: true, mode: 0o700 });
      const userData = realpathSync(requested);
      app.setPath('userData', userData);
      return userData;
    },
    catch: (error) =>
      ApplicationError.is(error)
        ? error
        : new ApplicationError({
            code: 'Unavailable',
            message: 'The Moonbase user-data directory is unavailable.',
          }),
  });
