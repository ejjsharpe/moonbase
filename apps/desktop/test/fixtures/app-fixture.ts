import type { ChildProcess } from 'node:child_process';

/**
 * Waits for an Electron app's process to exit once it has been asked to (Quit or `exit`). The
 * test's own timeout bounds it: how long the OS takes to tear the app down is not under test.
 */
export async function waitForExit(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null)
    await new Promise((resolve) => child.once('exit', resolve));
}
