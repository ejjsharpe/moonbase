import type { ManagedRuntime } from 'effect';
import {
  decodeWorkspaceInput,
  decodeWorkspaceOutput,
  decodeWorkspaceWatchInput,
  isWorkspaceCommand,
} from '@moonbase/contracts/workspace-schema';
import {
  ApplicationError,
  type CheckoutTarget,
  type EditorClient,
  type WorkspaceCommand,
  type WorkspaceEvent,
} from '@moonbase/contracts/workspace';
import { IpcLifetime, type IpcRequest } from './ipc-lifetime.ts';
import {
  checkout,
  errorDTO,
  invalid,
  keys,
  record,
  requestId,
  string,
  type Reply,
} from './wire.ts';

const exact = (a: CheckoutTarget, b: CheckoutTarget) =>
  ['hostId', 'checkoutId', 'projectId', 'root', 'branch'].every(
    (k) => a[k as keyof CheckoutTarget] === b[k as keyof CheckoutTarget],
  );
export type NativeActions = {
  chooseCheckout(): Promise<string | null>;
  imports(
    target: CheckoutTarget,
    kind: 'picker' | 'clipboard',
    paths?: string[],
    signal?: AbortSignal,
  ): Promise<string[]>;
  release(input: {
    checkout: CheckoutTarget;
    clientId: string;
    references: string[];
  }): Promise<void>;
};
/** Authority belongs to this main-frame session, never to an arbitrary renderer root or caller ID. */
export class EditorSession {
  readonly clientId = 'desktop-primary';
  private known = new Map<string, CheckoutTarget>();
  private rootGrants = new Set<string>();
  private operations = new Set<string>();
  private lifetime: IpcLifetime;
  private client: EditorClient;
  private native: NativeActions;
  private send: (id: string, result: Reply<WorkspaceEvent>) => void;
  constructor(
    runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
    client: EditorClient,
    native: NativeActions,
    send: (id: string, result: Reply<WorkspaceEvent>) => void,
  ) {
    this.lifetime = new IpcLifetime(runtime, 128, (error) => ({
      ok: false,
      error: errorDTO(error),
    }));
    this.client = client;
    this.native = native;
    this.send = send;
  }
  private own(value: unknown) {
    if (value !== this.clientId)
      throw new ApplicationError({ code: 'Unauthorized', message: 'Foreign editor identity.' });
  }
  private approved(value: unknown) {
    checkout(value);
    const known = this.known.get(value.checkoutId);
    if (!known || !exact(known, value))
      throw new ApplicationError({
        code: 'Unauthorized',
        message: 'Choose this exact checkout with the native picker.',
      });
  }
  private inspect(value: unknown, depth = 0): void {
    if (depth > 24) invalid('Input nesting limit exceeded.');
    if (typeof value === 'string') {
      if (value.length > 2 ** 24) invalid('Input too large.');
      return;
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return;
    if (Array.isArray(value)) {
      if (value.length > 8192) invalid('Input array too large.');
      for (const item of value) this.inspect(item, depth + 1);
      return;
    }
    const object = record(value);
    for (const item of Object.values(object)) this.inspect(item, depth + 1);
  }
  private validate(operation: WorkspaceCommand, input: unknown) {
    const v = record(decodeWorkspaceInput(operation, input));
    // Domain/path/state validation remains in WorkspaceService; this boundary additionally binds caller and approval.
    if (JSON.stringify(v).length > 32 * 1024 * 1024) invalid('Command input is too large.');
    this.inspect(v);
    if ('checkout' in v) this.approved(v.checkout);
    if ('target' in v) {
      const target = record(v.target);
      keys(target, ['checkout', 'path']);
      this.approved(target.checkout);
    }
    if (operation === 'operationStatus') {
      requestId(v.clientId);
      requestId(v.id);
      if (v.clientId !== this.clientId && !this.operations.has(JSON.stringify([v.clientId, v.id])))
        this.own(v.clientId);
    } else if ('clientId' in v) this.own(v.clientId);
    if (operation === 'acknowledgeOperation') {
      requestId(v.operationClientId);
      requestId(v.id);
      if (
        v.operationClientId !== this.clientId &&
        !this.operations.has(JSON.stringify([v.operationClientId, v.id]))
      )
        this.own(v.operationClientId);
    }
    if (operation === 'persistRecovery') {
      const state = record(v.state);
      this.own(state.clientId);
      if (!Array.isArray(state.checkouts)) invalid('Invalid checkout registry.');
      for (const target of state.checkouts as unknown[]) this.approved(target);
    }
    if (operation === 'openCheckout') {
      string(v.root);
      if (
        !this.rootGrants.delete(v.root) &&
        ![...this.known.values()].some((t) => t.root === v.root)
      )
        throw new ApplicationError({
          code: 'Unauthorized',
          message: 'A renderer path is not native root approval.',
        });
    }
    return v;
  }
  async call(method: unknown, input: unknown, id: unknown): Promise<Reply> {
    let reserved: IpcRequest | undefined;
    try {
      requestId(id);
      const admission = this.lifetime.getAdmissionError(id, method === 'watch');
      if (admission === 'closed')
        throw new ApplicationError({ code: 'Unavailable', message: 'Editor session disposed.' });
      if (admission === 'active') invalid('Request is already active.');
      if (admission === 'capacity') invalid('Too many active requests of this kind.');
      reserved = this.lifetime.reserveRequest(id, method === 'watch');
      const request = reserved;
      const live = request.isLive;
      const requireLive = () => {
        if (!live())
          throw new ApplicationError({ code: 'Cancelled', message: 'Editor document released.' });
      };
      let value: unknown;
      if (method === 'command') {
        const envelope = record(input);
        keys(envelope, ['operation', 'input']);
        if (!isWorkspaceCommand(envelope.operation)) invalid('Unknown application command.');
        const operation = envelope.operation as WorkspaceCommand;
        const validated = this.validate(operation, envelope.input);
        value = decodeWorkspaceOutput(
          operation,
          await this.client.command(operation, validated as never, { signal: request.signal }),
        );
        if (operation === 'openCheckout' && live()) {
          checkout(value);
          this.known.set(value.checkoutId, value);
        }
        if (operation === 'loadRecovery' && live()) {
          const load = value as Awaited<ReturnType<EditorClient['command']>> & {
            state: { checkouts: CheckoutTarget[] };
            operations: { clientId: string; id: string }[];
          };
          for (const target of load.state.checkouts) {
            checkout(target);
            this.known.set(target.checkoutId, target);
          }
          for (const fact of load.operations)
            this.operations.add(JSON.stringify([fact.clientId, fact.id]));
        }
      } else if (method === 'choose-checkout') {
        if (input !== null) invalid('Unexpected native picker input.');
        value = await this.native.chooseCheckout();
        requireLive();
        if (typeof value === 'string') this.rootGrants.add(value);
      } else if (
        method === 'choose-imports' ||
        method === 'clipboard-imports' ||
        method === 'dropped-imports'
      ) {
        const v = record(input);
        keys(v, method === 'dropped-imports' ? ['checkout', 'paths'] : ['checkout']);
        this.approved(v.checkout);
        if (
          v.paths !== undefined &&
          (!Array.isArray(v.paths) ||
            v.paths.length > 256 ||
            !v.paths.length ||
            v.paths.some((p) => typeof p !== 'string' || p.length > 4096))
        )
          invalid('Invalid native drop.');
        const checkout = v.checkout as CheckoutTarget;
        const references = await this.native.imports(
          checkout,
          method === 'clipboard-imports' ? 'clipboard' : 'picker',
          v.paths as string[] | undefined,
          request.signal,
        );
        const capture = { checkout, clientId: this.clientId, references };
        // Install cleanup ownership before any successful capture is published to the renderer.
        await request.retainDocumentRelease(() => this.native.release(capture));
        requireLive();
        value = references;
      } else if (method === 'watch') {
        const v = decodeWorkspaceWatchInput(input);
        this.inspect(v);
        this.approved(v.checkout);
        if (
          !Array.isArray(v.paths) ||
          v.paths.length > 8192 ||
          v.paths.some((p) => typeof p !== 'string')
        )
          invalid('Invalid watch paths.');
        await request.acquireWatch(() =>
          this.client.watch(
            v as never,
            (event) => {
              if (live()) this.send(id, { ok: true, value: event });
            },
            (error) => {
              if (live()) this.send(id, { ok: false, error: errorDTO(error) });
            },
          ),
        );
        return { ok: true, value: null };
      } else invalid('Unknown desktop method.');
      return { ok: true, value };
    } catch (error) {
      reserved?.fail();
      return { ok: false, error: errorDTO(error) };
    } finally {
      await reserved?.finish();
    }
  }
  cancel(id: unknown): Promise<Reply<null>> {
    requestId(id);
    return this.lifetime.cancel(id);
  }
  releaseDocument() {
    this.rootGrants.clear();
    return this.lifetime.releaseDocument();
  }
  dispose() {
    this.rootGrants.clear();
    return this.lifetime.dispose();
  }
}
