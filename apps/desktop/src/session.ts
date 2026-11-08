import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
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

/** Whether `path` is `root` or lies within it. */
const inside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
const exact = (a: CheckoutTarget, b: CheckoutTarget) => {
  const [x, y]: Record<string, unknown>[] = [a, b];
  const fields = Object.keys(x);
  return fields.length === Object.keys(y).length && fields.every((k) => x[k] === y[k]);
};
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
  /** Writes text to the OS clipboard. */
  copyText(text: string): Promise<void>;
  /** Shows an absolute path in the OS file manager. */
  reveal(path: string): Promise<void>;
};
/** Authority belongs to this main-frame session, never to an arbitrary renderer root or caller ID. */
export class EditorSession {
  readonly clientId = 'desktop-primary';
  private known = new Map<string, CheckoutTarget>();
  private rootGrants = new Set<string>();
  /** Worktree roots Git listed for an approved checkout; each may be opened like a picked root. */
  private worktreeRoots = new Set<string>();
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
  /**
   * The absolute path of `path` (relative, `/`-separated; empty for the root) inside an approved
   * checkout. The renderer can name nothing outside the checkouts the user chose.
   */
  private checkoutPath(target: unknown, path: unknown) {
    this.approved(target);
    const root = (target as CheckoutTarget).root;
    if (
      typeof path !== 'string' ||
      path.length > 4096 ||
      isAbsolute(path) ||
      path.includes('\0') ||
      path.includes('\\') ||
      (path !== '' && path.split('/').some((part) => part === '' || part === '.' || part === '..'))
    )
      invalid('Invalid checkout path.');
    const absolute = join(root, path as string);
    if (!inside(root, absolute)) invalid('Invalid checkout path.');
    return absolute;
  }
  private inspect(value: unknown, depth = 0, arrayLimit = 8192): void {
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
      if (value.length > arrayLimit) invalid('Input array too large.');
      for (const item of value) this.inspect(item, depth + 1, arrayLimit);
      return;
    }
    const object = record(value);
    for (const item of Object.values(object)) this.inspect(item, depth + 1, arrayLimit);
  }
  private validate(operation: WorkspaceCommand, input: unknown) {
    const v = record(decodeWorkspaceInput(operation, input));
    // Domain/path/state validation remains in WorkspaceService; this boundary additionally binds caller and approval.
    if (JSON.stringify(v).length > 32 * 1024 * 1024) invalid('Command input is too large.');
    this.inspect(v, 0, operation === 'getIgnoredPaths' ? 20000 : 8192);
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
        !this.worktreeRoots.has(v.root) &&
        ![...this.known.values()].some((t) => t.root === v.root)
      )
        throw new ApplicationError({
          code: 'Unauthorized',
          message: 'A renderer path is not native root approval.',
        });
    }
    if (operation === 'createWorktree')
      // A renderer location would create directories anywhere; it needs a native location grant first.
      throw new ApplicationError({
        code: 'Unauthorized',
        message: 'A renderer path is not native worktree location approval.',
      });
    return v;
  }
  /**
   * Opens a root main trusts, such as a chat's own folder becoming a project, and approves the
   * checkout for the renderer, which may then open it. The caller authorizes `root`.
   */
  async openFolderProject(root: string): Promise<CheckoutTarget> {
    string(root);
    const target = decodeWorkspaceOutput(
      'openCheckout',
      await this.client.command('openCheckout', { root }),
    );
    // The workspace resolves links: a folder replaced by one since main checked it opens elsewhere.
    if (target.root !== root)
      throw new ApplicationError({
        code: 'Unauthorized',
        message: 'The folder changed before it opened as a project. Inspect it.',
      });
    this.known.set(target.checkoutId, target);
    return target;
  }
  /** Whether a root is a natively approved checkout, or a worktree Git listed for one. */
  hasFolder(root: string) {
    return this.worktreeRoots.has(root) || [...this.known.values()].some((t) => t.root === root);
  }
  /**
   * Creates `branch` from the current commit of the checkout at `root`, in a new linked worktree
   * beside the repository at `<main worktree>-worktrees/<branch>`. Main derives the location, so a
   * renderer never names where directories are made. A taken branch or location gets a numbered
   * suffix. The caller authorizes `root`. Creations run one at a time, so two can't race for a name.
   */
  createChatWorktree(root: string, branch: string, signal?: AbortSignal) {
    const created = this.worktreeCreation.then(() => this.createWorktreeNow(root, branch, signal));
    this.worktreeCreation = created.catch(() => {});
    return created;
  }
  private worktreeCreation: Promise<unknown> = Promise.resolve();
  private async createWorktreeNow(root: string, branch: string, signal?: AbortSignal) {
    string(root);
    if (
      typeof branch !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(branch) ||
      branch.length > 100 ||
      branch.includes('..') ||
      branch.endsWith('.lock')
    )
      invalid('Choose a simple branch name for the worktree.');
    signal?.throwIfAborted();
    const options = signal ? { signal } : undefined;
    const target =
      [...this.known.values()].find((t) => t.root === root) ??
      decodeWorkspaceOutput(
        'openCheckout',
        await this.client.command('openCheckout', { root }, options),
      );
    const { worktrees } = decodeWorkspaceOutput(
      'listWorktrees',
      await this.client.command('listWorktrees', { checkout: target }, options),
    );
    const parent = `${worktrees.find((worktree) => worktree.main)?.root ?? target.root}-worktrees`;
    signal?.throwIfAborted();
    const madeParent = await mkdir(parent).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        return false;
      },
    );
    let prefix = branch;
    try {
      for (let attempt = 1; ; attempt++) {
        const name = attempt === 1 ? prefix : `${prefix}-${attempt}`;
        try {
          const created = decodeWorkspaceOutput(
            'createWorktree',
            await this.client.command(
              'createWorktree',
              {
                checkout: target,
                base: 'HEAD',
                branch: name,
                location: join(parent, name.replaceAll('/', '-')),
              },
              options,
            ),
          );
          // A released document's worktree stays on disk but grants nothing to the next document.
          if (!signal?.aborted) {
            this.known.set(created.checkoutId, created);
            this.worktreeRoots.add(created.root);
          }
          return created.root;
        } catch (error) {
          if (!ApplicationError.is(error) || ['Cancelled', 'Uncertain'].includes(error.code))
            throw error;
          if (error.code === 'Conflict' && attempt < 20) continue;
          // A branch named like the prefix (`chat`) blocks every `chat/…` branch, which Git
          // refuses (Unavailable): use `chat-…`. That maps to the same location, so any other
          // refusal of it would only repeat.
          if (error.code !== 'Unavailable' || !prefix.includes('/')) throw error;
          prefix = prefix.replaceAll('/', '-');
          attempt = 0;
        }
      }
    } catch (error) {
      // An empty folder this attempt made is removed; one holding other worktrees is kept.
      if (madeParent) await rmdir(parent).catch(() => {});
      throw error;
    }
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
        // After `git init` the folder's Git target replaces its approval under the same ID.
        if ((operation === 'openCheckout' || operation === 'initializeRepository') && live()) {
          checkout(value);
          this.known.set(value.checkoutId, value);
        }
        if (operation === 'listWorktrees' && live())
          for (const worktree of (value as { worktrees: { root: string }[] }).worktrees)
            this.worktreeRoots.add(worktree.root);
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
      } else if (method === 'copy-paths') {
        // Main writes the text, so the renderer can put only checkout paths on the clipboard.
        const v = record(input);
        keys(v, ['checkout', 'paths', 'relative']);
        if (
          !Array.isArray(v.paths) ||
          !v.paths.length ||
          v.paths.length > 20000 ||
          typeof v.relative !== 'boolean'
        )
          invalid('Invalid paths to copy.');
        const paths = v.paths as unknown[];
        const absolute = paths.map((path) => this.checkoutPath(v.checkout, path));
        await this.native.copyText((v.relative ? (paths as string[]) : absolute).join('\n'));
        value = null;
      } else if (method === 'reveal') {
        const v = record(input);
        keys(v, ['checkout', 'path']);
        const target = this.checkoutPath(v.checkout, v.path);
        // Follow links before checking again, so a link inside the checkout can't point out of it.
        const [root, real] = await Promise.all([
          realpath((v.checkout as CheckoutTarget).root),
          realpath(target),
        ]).catch(() => invalid('That file or folder no longer exists.'));
        if (!inside(root, real)) invalid('Invalid checkout path.');
        await this.native.reveal(real);
        value = null;
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
    this.worktreeRoots.clear();
    return this.lifetime.releaseDocument();
  }
  dispose() {
    this.rootGrants.clear();
    this.worktreeRoots.clear();
    return this.lifetime.dispose();
  }
}
