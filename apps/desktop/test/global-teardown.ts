import { stopTestDaemons } from './faux-daemon.mjs';

/** Daemons outlive the apps that started them; none started by these tests is left running. */
export default async function globalTeardown() {
  const stopped = await stopTestDaemons();
  if (stopped) console.info(`Stopped ${stopped} test daemon(s) left running.`);
}
