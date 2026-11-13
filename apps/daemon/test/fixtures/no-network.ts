// Preloaded into daemon test processes: provider requests fail instead of leaving the machine.
const original = globalThis.fetch;
globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
  const target = new URL(url instanceof Request ? url.url : url);
  if (target.hostname !== '127.0.0.1')
    throw Error('Provider network is disabled in this controlled daemon.');
  return original(url, options);
}) as typeof fetch;
