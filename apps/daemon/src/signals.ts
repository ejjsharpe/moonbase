/** Aborts on the first SIGTERM or SIGINT; later ones are ignored while the daemon closes. */
export function onShutdownSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return controller.signal;
}
