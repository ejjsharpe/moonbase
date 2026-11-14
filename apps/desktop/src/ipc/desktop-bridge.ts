/**
 * What the preload gives the renderer: a way to ask main for an IPC port, and a dropped file's
 * path. Nothing else crosses the context bridge; everything else travels over the port.
 */
export interface DesktopBridge {
  /** Asks main for a port; it arrives as a window message carrying `nonce` (`ipcPortMessage`). */
  connect(nonce: string): Promise<void>;
  /** The path of a file the user dropped or chose in a file input, or `''`. */
  pathForFile(file: File): string;
}
/** The one channel family between preload and main: the connect request and its port. */
export const ipcChannels = { connect: 'moonbase:connect', port: 'moonbase:port' } as const;
/** The `type` of the window message that hands the renderer its port. */
export const ipcPortMessage = 'moonbase:port';
/** A nonce the renderer mints for a connect request. */
export const isIpcNonce = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
