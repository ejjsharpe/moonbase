import { stopTestDaemons } from './faux-daemon.mjs';

/**
 * Daemons outlive the apps that started them; none started by this run is left running. Another
 * run's (a concurrent one in another worktree) keep their own folder and are left alone.
 */
export default async function globalTeardown() {
  const stopped = await stopTestDaemons(process.env.MOONBASE_TEST_RUN_TMPDIR!);
  if (stopped) console.info(`Stopped ${stopped} test daemon(s) left running.`);
}
