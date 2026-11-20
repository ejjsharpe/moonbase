/**
 * Records each WebSocket a client opens in this test, with the protocols it offered (its proof is
 * the second), so a test can count sockets, compare their proofs or drop one. With `refuse` set,
 * a socket offers a proof the daemon refuses in place of its own.
 */
export function recordSockets(t: { after(run: () => unknown): void }) {
  const Original = globalThis.WebSocket;
  const opened: { protocols: string[]; socket: WebSocket }[] = [];
  const recorder = { opened, refuse: false };
  globalThis.WebSocket = class extends Original {
    constructor(url: string | URL, protocols?: string | string[]) {
      const offered = [protocols ?? []].flat();
      super(url, recorder.refuse ? [offered[0]!, `moonbase.proof.${'A'.repeat(43)}.x`] : offered);
      opened.push({ protocols: offered, socket: this });
    }
  } as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = Original;
  });
  return recorder;
}
