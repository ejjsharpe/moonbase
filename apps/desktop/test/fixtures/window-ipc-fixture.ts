import type { Page } from '@playwright/test';

/** One request's outcome as a renderer sees it on the wire. */
export type WindowIpcReply = {
  ok: boolean;
  value?: unknown;
  error?: { _tag: string; code?: string; message?: string; [field: string]: unknown };
};
type Request = { tag: string; payload: unknown; interrupt?: boolean };

/**
 * Sends one request to main over a port of its own, as raw Effect RPC, from the page it runs in;
 * `interrupt` cancels it straight after. Self-contained, so it can run in any window's page.
 */
export async function callMainFromPage({
  tag,
  payload,
  interrupt,
}: Request): Promise<WindowIpcReply> {
  const nonce = crypto.randomUUID();
  let port: MessagePort;
  try {
    port = await new Promise<MessagePort>((resolve, reject) => {
      const receive = (event: MessageEvent) => {
        const data = event.data as { type?: unknown; nonce?: unknown } | null;
        if (event.source !== window || data?.type !== 'moonbase:port' || data.nonce !== nonce)
          return;
        window.removeEventListener('message', receive);
        resolve(event.ports[0]!);
      };
      window.addEventListener('message', receive);
      window.moonbase.connect(nonce).catch((error: unknown) => {
        window.removeEventListener('message', receive);
        reject(error);
      });
    });
  } catch (error) {
    return { ok: false, error: { _tag: 'Refused', message: String((error as Error).message) } };
  }
  try {
    return await new Promise<WindowIpcReply>((resolve) => {
      port.onmessage = (event) => {
        const frame = JSON.parse(event.data as string);
        if (frame._tag === 'Defect')
          return resolve({ ok: false, error: { _tag: 'Defect', defect: frame.defect } });
        if (frame._tag !== 'Exit' || frame.requestId !== '0') return;
        const exit = frame.exit;
        if (exit._tag === 'Success') return resolve({ ok: true, value: exit.value });
        const reason =
          exit.cause.find((item: { _tag: string }) => item._tag === 'Fail') ?? exit.cause[0];
        resolve({
          ok: false,
          error:
            reason._tag === 'Fail' ? reason.error : { _tag: reason._tag, defect: reason.defect },
        });
      };
      port.postMessage(JSON.stringify({ _tag: 'Request', id: '0', tag, payload, headers: [] }));
      if (interrupt)
        port.postMessage(JSON.stringify({ _tag: 'Interrupt', requestId: '0', interruptors: [] }));
    });
  } finally {
    port.close();
  }
}
/** Script that runs `callMainFromPage` in whatever page evaluates it (`executeJavaScript`). */
export const callMainScript = (tag: string, payload: unknown = null, interrupt = false) =>
  `(${callMainFromPage.toString()})(${JSON.stringify({ tag, payload, interrupt })})`;
/**
 * `callMainFromPage` in `page`. The reply crosses back as JSON text, so own `__proto__` keys
 * survive Playwright's serializer.
 */
export const callMain = async (
  page: Page,
  tag: string,
  payload: unknown = null,
  interrupt = false,
): Promise<WindowIpcReply> =>
  JSON.parse(
    await page.evaluate(
      `(async () => JSON.stringify(await ${callMainScript(tag, payload, interrupt)}))()`,
    ),
  );
/** The editor's client ID, the only one its document may act as. */
export const editorClientId = 'desktop-primary';
/** The remote host's connection as main reports it. */
export const getConnection = (page: Page) => callMain(page, 'getConnection', { input: {} });
/** Disconnects the remote host if it is connected, as cleanup after a test. */
export async function disconnectHost(page: Page) {
  const state = await getConnection(page);
  const connectionId = (state.value as { connectionId?: string | null } | undefined)?.connectionId;
  if (state.ok && connectionId) await callMain(page, 'disconnect', { input: { connectionId } });
}
