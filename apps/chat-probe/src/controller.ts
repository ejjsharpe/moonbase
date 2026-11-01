import { ApplicationError } from "@moonbase/application/client";
import type {
  ChatClient,
  ChatHostConfiguration,
  ChatInput,
  ChatSession,
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
  ChatStopTarget,
  ChatEntry,
} from "@moonbase/application/chat-client";
import type { ConnectionClient, ConnectionSnapshot } from "@moonbase/application/connection-client";

export type Pending = (
  | { operation: "createChat"; input: ChatInput<"createChat"> }
  | { operation: "sendChat"; input: ChatInput<"sendChat"> }
  | { operation: "stopChat"; input: ChatInput<"stopChat"> }
) & { message: string };
type Saved = {
  version: 1;
  session: ChatSession;
  selected: ChatTarget | null;
  drafts: { target: ChatTarget; text: string }[];
  pending: Pending[];
};
export type DraftStorage = Pick<Storage, "getItem" | "setItem">;
export type ChatProofState = {
  connection: ConnectionSnapshot | null;
  host: ChatHostConfiguration | null;
  chats: ChatSummary[];
  nextChats: string | null;
  snapshot: ChatSnapshot | null;
  older: ChatEntry[];
  olderCursor: string | null;
  selected: ChatTarget | null;
  draft: string;
  pending: Pending[];
  active: string[];
  error: string | null;
  storageError: string | null;
  notice: string;
};
const key = "moonbase.chat-proof.v1";
const sameHost = (a: ChatSession["host"], b: ChatSession["host"]) =>
  a.hostId === b.hostId && a.storeId === b.storeId;
const sameSession = (a: ChatSession, b: ChatSession) =>
  sameHost(a.host, b.host) && a.actorId === b.actorId;
const sameTarget = (a: ChatTarget | null, b: ChatTarget | null) =>
  a === b || (!!a && !!b && sameSession(a, b) && a.conversationId === b.conversationId);
const sameStop = (a: ChatStopTarget, b: ChatStopTarget) =>
  sameTarget(a.target, b.target) && a.submissionId === b.submissionId && a.taskId === b.taskId;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const text = (s: unknown, limit: number): s is string =>
  typeof s === "string" && s.isWellFormed() && !s.includes("\0") && bytes(s) <= limit;
const id = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(s);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) =>
  Object.keys(v).length === fields.length && fields.every((k) => Object.hasOwn(v, k));
function host(v: unknown): v is ChatSession["host"] {
  return object(v) && exact(v, ["hostId", "storeId"]) && id(v.hostId) && id(v.storeId);
}
function session(v: unknown): v is ChatSession {
  return (
    object(v) &&
    exact(v, ["host", "actorId"]) &&
    host(v.host) &&
    id(v.actorId)
  );
}
function target(v: unknown, s: ChatSession): v is ChatTarget {
  return (
    object(v) &&
    exact(v, ["host", "actorId", "conversationId"]) &&
    host(v.host) &&
    sameHost(v.host, s.host) &&
    v.actorId === s.actorId &&
    id(v.conversationId)
  );
}
function validate(v: unknown, s: ChatSession): asserts v is Saved {
  if (
    !object(v) ||
    !exact(v, ["version", "session", "selected", "drafts", "pending"]) ||
    v.version !== 1 ||
    !session(v.session) ||
    !sameSession(v.session, s) ||
    (v.selected !== null && !target(v.selected, s)) ||
    !Array.isArray(v.drafts) ||
    v.drafts.length > 32 ||
    !Array.isArray(v.pending) ||
    v.pending.length > 16
  )
    throw Error(
      "Saved drafts have an incompatible context or format. Preserve the existing chat-proof data; use its original host/store/actor.",
    );
  const drafts = new Set<string>(),
    requests = new Set<string>();
  for (const d of v.drafts) {
    if (
      !object(d) ||
      !exact(d, ["target", "text"]) ||
      !target(d.target, s) ||
      !text(d.text, 32768) ||
      drafts.has(JSON.stringify(d.target))
    )
      throw Error("Saved draft is invalid. Preserve the existing data for recovery.");
    drafts.add(JSON.stringify(d.target));
  }
  for (const p of v.pending) {
    if (
      !object(p) ||
      !exact(p, ["operation", "input", "message"]) ||
      !object(p.input) ||
      !id(p.input.requestId) ||
      !text(p.message, 1024) ||
      requests.has(p.input.requestId)
    )
      throw Error("Saved pending identity is invalid. Preserve the existing data for recovery.");
    requests.add(p.input.requestId);
    const i = p.input;
    if (
      p.operation === "createChat" &&
      exact(i, ["session", "requestId", "title"]) &&
      session(i.session) &&
      sameSession(i.session, s) &&
      text(i.title, 200) &&
      i.title.trim()
    )
      continue;
    if (
      p.operation === "sendChat" &&
      exact(i, ["target", "requestId", "text"]) &&
      target(i.target, s) &&
      text(i.text, 32768) &&
      i.text.trim()
    )
      continue;
    if (
      p.operation === "stopChat" &&
      exact(i, ["stop", "requestId"]) &&
      object(i.stop) &&
      exact(i.stop, ["target", "submissionId", "taskId"]) &&
      target(i.stop.target, s) &&
      id(i.stop.submissionId) &&
      (i.stop.taskId === null || id(i.stop.taskId))
    )
      continue;
    throw Error("Saved pending command is invalid. Preserve the existing data for recovery.");
  }
}
/** Ordinary browser state only: drafts/immutable command inputs, never execution or transcript authority. */
export class ChatProofController {
  private saved: Saved;
  private raw: string | null = null;
  private state: ChatProofState;
  private listeners = new Set<() => void>();
  private stopConnection?: () => void;
  private stopChat?: () => void;
  private epoch = 0;
  private closed = false;
  private attached = false;
  private inFlight = new Set<string>();
  readonly chat: ChatClient;
  readonly connection: ConnectionClient;
  readonly context: ChatSession;
  private storage: DraftStorage;
  private newId: () => string;
  constructor(
    chat: ChatClient,
    connection: ConnectionClient,
    context: ChatSession,
    storage: DraftStorage,
    newId: () => string = () => crypto.randomUUID(),
  ) {
    this.chat = chat;
    this.connection = connection;
    this.context = structuredClone(context);
    this.storage = storage;
    this.newId = newId;
    if (!session(context)) throw Error("Configure an exact host, store and actor.");
    this.saved = {
      version: 1,
      session: structuredClone(context),
      selected: null,
      drafts: [],
      pending: [],
    };
    let storageError: string | null = null;
    try {
      this.raw = storage.getItem(key);
      if (this.raw !== null) {
        if (bytes(this.raw) > 2 * 1024 * 1024)
          throw Error("Saved chat-proof data exceeds its bound. Preserve it for recovery.");
        const v: unknown = JSON.parse(this.raw);
        validate(v, context);
        this.saved = v;
      }
    } catch (e) {
      storageError =
        e instanceof Error
          ? e.message
          : "Draft storage is unavailable. No new command will be sent.";
    }
    this.state = {
      connection: null,
      host: null,
      chats: [],
      nextChats: null,
      snapshot: null,
      older: [],
      olderCursor: null,
      selected: this.saved.selected,
      draft: this.draft(),
      pending: this.saved.pending,
      active: [],
      error: null,
      storageError,
      notice: "Disconnected. Connect explicitly; reconnect never resends a message.",
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<ChatProofState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...change };
    for (const f of this.listeners) f();
  }
  private draft() {
    return this.saved.drafts.find((d) => sameTarget(d.target, this.saved.selected))?.text ?? "";
  }
  private commit(next: Saved) {
    if (this.state.storageError) throw Error(this.state.storageError);
    validate(next, this.context);
    const raw = JSON.stringify(next);
    try {
      if (this.storage.getItem(key) !== this.raw)
        throw Error(
          "Draft storage changed in another client. Reload to preserve both versions before sending.",
        );
      this.storage.setItem(key, raw);
      this.raw = raw;
      this.saved = next;
      this.update({ selected: next.selected, draft: this.draft(), pending: next.pending });
    } catch {
      this.update({
        storageError:
          "Draft preservation failed or another client changed it. Keep this window open; no new mutation can start.",
      });
      throw Error("Draft preservation failed.");
    }
  }
  private error(e: unknown) {
    const f = ApplicationError.fromUnknown(e);
    this.update({ error: `${f.code}: ${f.message}` });
  }
  private async action(name: string, f: () => Promise<void>) {
    if (this.inFlight.has(name) || this.closed) return;
    this.inFlight.add(name);
    this.update({ active: [...this.inFlight], error: null });
    try {
      await f();
    } catch (e) {
      this.error(e);
    } finally {
      this.inFlight.delete(name);
      this.update({ active: [...this.inFlight] });
    }
  }
  async start() {
    if (this.stopConnection || this.closed) return;
    this.attached = true;
    this.stopConnection = this.connection.watch(
      (s) => this.onConnection(s),
      (e) => this.error(e),
    );
    await this.action("status", async () =>
      this.onConnection(await this.connection.command("getConnection", {})),
    );
    if (this.state.connection?.state === "connected" && !this.state.host) await this.refresh();
  }
  private onConnection(s: ConnectionSnapshot) {
    if (!this.attached || this.closed) return;
    const previous = this.state.connection;
    const changed = previous?.connectionId !== s.connectionId || previous?.state !== s.state;
    this.update({ connection: s });
    if (changed) {
      this.epoch++;
      this.stopChat?.();
      this.stopChat = undefined;
      this.update({ snapshot: null, older: [], olderCursor: null, host: null });
      if (s.state === "connected") void this.refresh();
    }
  }
  connect = () =>
    this.action("connect", async () => {
      const s = this.state.connection;
      if (!s) return;
      this.onConnection(await this.connection.command("connect", { profileId: s.profile.id }));
    });
  disconnect = () =>
    this.action("disconnect", async () => {
      const id = this.state.connection?.connectionId;
      if (id) {
        await this.connection.command("disconnect", { connectionId: id });
        this.onConnection(await this.connection.command("getConnection", {}));
      }
    });
  private connected() {
    if (this.state.connection?.state !== "connected")
      throw new ApplicationError({
        code: "Unavailable",
        message: "Connect to the configured host first.",
      });
    return this.epoch;
  }
  refresh = () =>
    this.action("refresh", async () => {
      const epoch = this.connected();
      const host = await this.chat.command("getChatHost", { host: this.context.host });
      if (!sameSession(host, this.context))
        throw new ApplicationError({
          code: "Incompatible",
          message: "Host actor does not match the configured proof context.",
        });
      const page = await this.chat.command("listChats", { session: this.context });
      if (epoch !== this.epoch || this.closed) return;
      this.update({
        host,
        chats: page.conversations,
        nextChats: page.nextCursor,
        notice: "Verified host. Reconnection reads saved state; it does not send.",
      });
      if (this.saved.selected) await this.observe(this.saved.selected, epoch);
      for (const p of [...this.saved.pending])
        if (p.operation === "sendChat") await this.query(p.input.requestId);
    });
  moreChats = () =>
    this.action("chats", async () => {
      const epoch = this.connected(),
        cursor = this.state.nextChats;
      if (!cursor) return;
      const p = await this.chat.command("listChats", { session: this.context, cursor });
      if (epoch === this.epoch) this.update({ chats: p.conversations, nextChats: p.nextCursor });
    });
  firstChats = () => this.refresh();
  setDraft(value: string) {
    if (!text(value, 32768)) {
      this.update({ error: "Message must contain valid Unicode and at most 32 KiB." });
      return;
    }
    const target = this.saved.selected;
    if (!target) return;
    // Retain a live edit if persistence fails; admission remains blocked until preserved.
    this.update({ draft: value });
    try {
      const next = structuredClone(this.saved);
      if (!value) next.drafts = next.drafts.filter((d) => !sameTarget(d.target, target));
      else {
        const entry = next.drafts.find((d) => sameTarget(d.target, target));
        if (entry) entry.text = value;
        else next.drafts.push({ target, text: value });
      }
      this.commit(next);
    } catch (e) {
      this.update({
        storageError:
          this.state.storageError ??
          "This live edit could not be preserved within the draft bound. Copy it before closing; mutations and Quit are blocked.",
      });
      this.error(e);
    }
  }
  select = (target: ChatTarget) =>
    this.action("open", async () => {
      if (
        !target ||
        !sameHost(target.host, this.context.host) ||
        target.actorId !== this.context.actorId
      )
        throw Error("Chat belongs to another context.");
      const next = structuredClone(this.saved);
      next.selected = target;
      this.commit(next);
      this.connected();
      await this.observe(target, ++this.epoch);
    });
  closeView() {
    this.epoch++;
    this.stopChat?.();
    this.stopChat = undefined;
    try {
      this.commit({ ...structuredClone(this.saved), selected: null });
      this.update({ snapshot: null, older: [], olderCursor: null });
    } catch (e) {
      this.error(e);
    }
  }
  private async observe(target: ChatTarget, epoch: number) {
    if (!this.attached || this.closed) return;
    this.stopChat?.();
    this.stopChat = undefined;
    this.update({ snapshot: null, older: [], olderCursor: null });
    let received = false;
    const accept = (s: ChatSnapshot) => {
      if (epoch === this.epoch && sameTarget(this.saved.selected, target) && !this.closed)
        this.update({
          snapshot: s,
          ...(this.state.older.length ? {} : { olderCursor: s.olderCursor }),
        });
    };
    // Register before the initial read; the service delivers replacement snapshots.
    this.stopChat = this.chat.watch(
      { target },
      (s) => {
        received = true;
        accept(s);
      },
      (e) => {
        if (epoch === this.epoch) this.error(e);
      },
    );
    const s = await this.chat.command("getChat", { target });
    if (!received) accept(s);
  }
  older = () =>
    this.action("history", async () => {
      const target = this.saved.selected,
        cursor = this.state.olderCursor,
        epoch = this.connected();
      if (!target || !cursor) return;
      const p = await this.chat.command("getChatHistory", { target, cursor });
      if (epoch === this.epoch && sameTarget(target, this.saved.selected))
        this.update({ older: p.entries, olderCursor: p.olderCursor });
    });
  private reserve(p: Pending) {
    const next = structuredClone(this.saved);
    if (next.pending.length >= 16)
      throw Error("Resolve an existing pending command before creating another.");
    next.pending.push(p);
    this.commit(next);
  }
  create = (title: string) =>
    this.action("create", async () => {
      this.connected();
      if (!text(title, 200) || !title.trim()) throw Error("Use a chat title of 1–200 UTF-8 bytes.");
      const p: Pending = {
        operation: "createChat",
        input: { session: structuredClone(this.context), requestId: this.newId(), title },
        message: "Outcome pending. Original creation identity retained.",
      };
      this.reserve(p);
      await this.dispatch(p);
    });
  send = () =>
    this.action("send", async () => {
      this.connected();
      const target = this.saved.selected,
        value = this.state.draft;
      if (!target || !text(value, 32768) || !value.trim())
        throw Error("Write a message before sending.");
      if (
        this.saved.pending.some((p) => p.operation === "sendChat" && sameTarget(p.input.target, target))
      )
        throw Error("Resolve the retained Send before starting another in this chat.");
      const p: Pending = {
        operation: "sendChat",
        input: { target: structuredClone(target), requestId: this.newId(), text: value },
        message: "Outcome pending. Original Send identity and text retained.",
      };
      this.reserve(p);
      await this.dispatch(p);
    });
  stop = () =>
    this.action("stop", async () => {
      this.connected();
      const stop = this.state.snapshot?.run?.stop;
      if (!stop) return;
      if (this.saved.pending.some((p) => p.operation === "stopChat" && sameStop(p.input.stop, stop)))
        throw Error("Resolve the captured Stop before requesting it again.");
      const p: Pending = {
        operation: "stopChat",
        input: { stop: structuredClone(stop), requestId: this.newId() },
        message: "Outcome pending. Exact submission/task retained.",
      };
      this.reserve(p);
      await this.dispatch(p);
    });
  retry = (id: string) =>
    this.action(id, async () => {
      this.connected();
      const p = this.saved.pending.find((p) => p.input.requestId === id);
      if (!p) return;
      await this.queryPending(p);
      if (this.saved.pending.some((q) => q.input.requestId === id)) await this.dispatch(p);
    });
  query = (id: string) =>
    this.action("query:" + id, async () => {
      this.connected();
      const p = this.saved.pending.find((p) => p.input.requestId === id);
      if (p) await this.queryPending(p);
    });
  private async queryPending(p: Pending) {
    if (p.operation === "sendChat") {
      const r = await this.chat.command("getChatSend", {
        target: p.input.target,
        requestId: p.input.requestId,
      });
      if (r?.admission === "admitted") {
        this.resolve(p);
        this.update({ notice: "Original Send admission recovered without resending." });
      } else
        this.update({
          notice:
            "No confirmed admission. Keep the original ID; only an explicit matching retry may send.",
        });
    } else if (p.operation === "createChat") {
      await this.chat.command("listChats", { session: p.input.session });
      this.update({
        notice:
          "Saved chats read. Creation identity cannot be proven by title; explicitly retry the original creation ID.",
      });
    } else {
      await this.chat.command("getChat", { target: p.input.stop.target });
      this.update({
        notice:
          "Current state read. The retained Stop still targets its original task; retry never adopts its successor.",
      });
    }
  }
  private resolve(p: Pending, conversation?: ChatSummary) {
    const next = structuredClone(this.saved);
    next.pending = next.pending.filter((q) => q.input.requestId !== p.input.requestId);
    if (p.operation === "sendChat")
      next.drafts = next.drafts.filter(
        (d) => !sameTarget(d.target, p.input.target) || d.text !== p.input.text,
      );
    if (conversation) next.selected = conversation.target;
    this.commit(next);
  }
  private async dispatch(p: Pending) {
    // A read-only reconciliation may await while another client replaces local preservation.
    this.commit(structuredClone(this.saved));
    try {
      if (p.operation === "createChat") {
        const r = await this.chat.command(p.operation, p.input);
        this.resolve(p, r.conversation);
        this.update({
          chats: [
            r.conversation,
            ...this.state.chats.filter((c) => !sameTarget(c.target, r.conversation.target)),
          ].slice(0, 32),
        });
        if (this.state.connection?.state === "connected")
          await this.observe(r.conversation.target, this.epoch);
      } else if (p.operation === "sendChat") {
        const r = await this.chat.command(p.operation, p.input);
        if (r.admission === "admitted") this.resolve(p);
        else
          this.note(
            p,
            "Reserved; admission is unconfirmed. Query before an explicit matching retry.",
          );
      } else {
        const r = await this.chat.command(p.operation, p.input);
        if (r.outcome === "pending")
          this.note(p, "Stop remains pending; cooperative cancellation is not confirmed.");
        else {
          this.resolve(p);
          this.update({ notice: `Captured Stop: ${r.outcome}.` });
        }
      }
    } catch (e) {
      const f = ApplicationError.fromUnknown(e);
      this.note(p, `${f.code}: ${f.message}`.slice(0, 1000));
      throw e;
    }
  }
  private note(p: Pending, message: string) {
    const next = structuredClone(this.saved),
      entry = next.pending.find((q) => q.input.requestId === p.input.requestId);
    if (entry) entry.message = message;
    this.commit(next);
  }
  preserve() {
    if (this.state.storageError) return false;
    try {
      this.commit(structuredClone(this.saved));
      return true;
    } catch {
      return false;
    }
  }
  detach() {
    this.attached = false;
    this.epoch++;
    this.stopConnection?.();
    this.stopConnection = undefined;
    this.stopChat?.();
    this.stopChat = undefined;
    this.update({ snapshot: null, older: [], olderCursor: null, host: null });
  }
  dispose() {
    this.detach();
    this.closed = true;
    this.listeners.clear();
  }
}
