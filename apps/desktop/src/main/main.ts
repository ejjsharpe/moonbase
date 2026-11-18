import { app } from 'electron';
import { Cause, Exit, Runtime } from 'effect';
import { desktopProgram } from './desktop-program.ts';

/**
 * Runs Electron main's one program on one runtime. Electron owns signals and the quit sequence,
 * so this runner installs no signal handlers: the program ends at Quit, then Electron quits with
 * its exit code.
 */
const runElectronMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  fiber.addObserver((exit) =>
    teardown(exit, (code) => {
      if (code === 0) app.quit();
      else app.exit(code);
    }),
  );
});

runElectronMain(desktopProgram, {
  teardown: (exit, onExit) => {
    if (Exit.isSuccess(exit)) return onExit(exit.value as number);
    console.error(Cause.pretty(exit.cause));
    onExit(1);
  },
});
