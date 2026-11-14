// The part of `Bun.serve` the daemon's listener uses, typed here so the package needs no Bun type
// package. Only the daemon runs it, under Bun; clients never import this file.

/** One accepted WebSocket. Bun answers pings itself, and messages arrive whole. */
export interface BunWebSocket<Data> {
  readonly data: Data;
  sendBinary(data: Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  terminate(): void;
  /** Stops reading from the connection until `resume`. */
  pause(): void;
  resume(): void;
  /** Bytes sent but not yet written to the connection. */
  getBufferedAmount(): number;
}

export interface BunServer<Data> {
  readonly port: number;
  upgrade(request: Request, options: { data: Data; headers?: Record<string, string> }): boolean;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export type BunServeOptions<Data> = {
  hostname: string;
  port: number;
  /** Seconds an HTTP connection may stay idle; at most 255. */
  idleTimeout: number;
  /** Off, so Bun never answers with its development error page (paths, source and a stack). */
  development: false;
  /** Answers a request whose handler threw; Bun's own answer would describe the failure. */
  error(error: unknown): Response;
  fetch(
    request: Request,
    server: BunServer<Data>,
  ): Response | undefined | Promise<Response | undefined>;
  websocket: {
    /** The largest message Bun accepts; a larger one closes its connection. */
    maxPayloadLength: number;
    /** Seconds before Bun closes a quiet socket; 0 leaves it to the protocol. */
    idleTimeout: number;
    /** Bytes Bun buffers for a socket before it drops what is sent. */
    backpressureLimit: number;
    closeOnBackpressureLimit: boolean;
    sendPings: boolean;
    perMessageDeflate: boolean;
    open(socket: BunWebSocket<Data>): void;
    message(socket: BunWebSocket<Data>, message: string | Uint8Array): void;
    ping(socket: BunWebSocket<Data>): void;
    drain(socket: BunWebSocket<Data>): void;
    close(socket: BunWebSocket<Data>): void;
  };
};

/** Starts `Bun.serve`; outside Bun there is no listener to start. */
export function serveBun<Data>(options: BunServeOptions<Data>): BunServer<Data> {
  const bun = (globalThis as { Bun?: { serve(options: BunServeOptions<Data>): BunServer<Data> } })
    .Bun;
  if (!bun) throw Error('The daemon listener runs only under Bun.');
  return bun.serve(options);
}
