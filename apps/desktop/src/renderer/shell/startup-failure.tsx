import * as stylex from '@stylexjs/stylex';
import { workbench } from '@moonbase/ui/workbench';
import { styles } from './shell-styles.ts';

export function WorkbenchStartupFailure({ message }: { message: string }) {
  return (
    <main
      role="alert"
      aria-label="Workbench startup failed"
      {...stylex.props(workbench.document, styles.empty)}>
      <h1>The workbench could not initialize</h1>
      <p>{message}</p>
      <p>
        Keep this user-data directory. Preserved recovery remains available; no saved work was
        reset.
      </p>
      <p>Quit Moonbase from the application menu before trying again.</p>
    </main>
  );
}
