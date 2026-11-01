import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationError } from "@moonbase/application/client";
import type {
  ChatClient,
  ChatSnapshot,
  ChatTarget,
  ChatCommands,
} from "@moonbase/application/chat-client";
import type { ConnectionClient, ConnectionSnapshot } from "@moonbase/application/connection-client";
import { ChatProofController, type DraftStorage } from "../src/controller.ts";
const context = { host: { hostId: "host", storeId: "store" }, actorId: "owner" },
  target = { ...context, conversationId: "chat" };
const summary = {
  target,
  title: "Saved",
  cwd: "/remote/folder",
  model: "configured-model",
  createdAt: "2026-01-01T00:00:00Z",
};
const snapshot: ChatSnapshot = {
  conversation: summary,
  state: "idle",
  run: null,
  entries: [],
  olderCursor: null,
};
const profile = {
  id: "configured",
  label: "Configured",
  destination: "example",
  remotePort: 9876,
  expected: context.host,
};
const failure = () =>
  new ApplicationError({ code: "Uncertain", message: "Controlled response loss" });
class Storage implements DraftStorage {
  value: string | null = null;
  fail = false;
  getItem() {
    return this.value;
  }
  setItem(_key: string, value: string) {
    if (this.fail) throw Error("Controlled full storage");
    this.value = value;
  }
}
function fixture(storage = new Storage()) {
  let connectionState: ConnectionSnapshot = { state: "disconnected", connectionId: null, profile },
    receiveConnection: (v: ConnectionSnapshot) => void = () => {},
    receiveChat: (v: ChatSnapshot) => void = () => {};
  let subscriptions = 0,
    id = 0;
  const calls: { operation: string; input: unknown }[] = [];
  const answers = new Map<string, (v: never) => Promise<unknown>>();
  const chat: ChatClient = {
    command: async (op, input) => {
      calls.push({ operation: op, input: structuredClone(input) });
      const handler = answers.get(op);
      if (handler) return (await handler(input as never)) as never;
      switch (op) {
        case "getChatHost":
          return { ...context, cwd: summary.cwd, model: summary.model } as never;
        case "listChats":
          return { conversations: [summary], nextCursor: null } as never;
        case "createChat":
          return {
            requestId: (input as ChatCommands["createChat"]["input"]).requestId,
            conversation: summary,
          } as never;
        case "getChat":
          return structuredClone(snapshot) as never;
        case "sendChat":
          return {
            target,
            requestId: (input as ChatCommands["sendChat"]["input"]).requestId,
            admission: "admitted",
            submissionId: "submission",
          } as never;
        case "getChatSend":
          return null as never;
        case "stopChat":
          return { ...input, outcome: "terminal" } as never;
        default:
          throw Error(op);
      }
    },
    watch: (_i, receive) => {
      receiveChat = receive;
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
  };
  const connection: ConnectionClient = {
    command: async (op) => {
      calls.push({ operation: op, input: {} });
      if (op === "connect") {
        connectionState = {
          state: "connected",
          connectionId: "generation-" + ++id,
          profile,
          health: { ...context.host, protocol: 1, version: "0.1.0", capabilities: ["chat-v0"] },
        };
        receiveConnection(connectionState);
      }
      if (op === "disconnect") {
        connectionState = { state: "disconnected", connectionId: null, profile };
        receiveConnection(connectionState);
      }
      return connectionState as never;
    },
    watch: (receive) => {
      receiveConnection = receive;
      return () => {};
    },
  };
  const controller = new ChatProofController(
    chat,
    connection,
    context,
    storage,
    () => `request-${++id}`,
  );
  return {
    controller,
    chat,
    connection,
    calls,
    answers,
    storage,
    publish: (v: ChatSnapshot) => receiveChat(v),
    get subscriptions() {
      return subscriptions;
    },
  };
}
const turn = () => new Promise((r) => setTimeout(r, 0));
async function ready(f: ReturnType<typeof fixture>) {
  await f.controller.start();
  await f.controller.connect();
  await turn();
  await f.controller.select(target);
}

test("startup only observes; every mutation is durably captured before disclosure", async () => {
  const f = fixture();
  await f.controller.start();
  assert(
    !f.calls.some((c) => ["connect", "createChat", "sendChat", "stopChat"].includes(c.operation)),
  );
  await ready(f);
  f.controller.setDraft("captured");
  f.answers.set("sendChat", async (input) => {
    const saved = JSON.parse(f.storage.value!);
    assert.deepEqual(saved.pending[0].input, input);
    return {
      target,
      requestId: saved.pending[0].input.requestId,
      admission: "admitted",
      submissionId: "one",
    };
  });
  await f.controller.send();
  assert.equal(f.controller.getSnapshot().draft, "");
  assert.equal(f.controller.getSnapshot().pending.length, 0);
  f.controller.dispose();
});
test("lost reply, null query, reload and reconnect retain original input without auto Send", async () => {
  const f = fixture();
  await ready(f);
  f.controller.setDraft("original");
  f.answers.set("sendChat", async () => {
    throw failure();
  });
  await f.controller.send();
  const p = f.controller.getSnapshot().pending[0];
  assert(p.operation === "sendChat");
  assert.equal(p.input.text, "original");
  await f.controller.query(p.input.requestId);
  assert.deepEqual(f.controller.getSnapshot().pending[0].input, p.input);
  f.controller.dispose();
  const second = new ChatProofController(f.chat, f.connection, context, f.storage);
  await second.start();
  await turn();
  assert.deepEqual(second.getSnapshot().pending[0].input, p.input);
  assert.equal(f.calls.filter((c) => c.operation === "sendChat").length, 1);
  await second.disconnect();
  await second.connect();
  await turn();
  assert.equal(f.calls.filter((c) => c.operation === "sendChat").length, 1);
  second.dispose();
});
test("matching Send recovery clears only captured draft text and preserves newer edits", async () => {
  const f = fixture();
  await ready(f);
  f.controller.setDraft("captured");
  let release!: (v: unknown) => void;
  f.answers.set("sendChat", () => new Promise((r) => (release = r)));
  const sending = f.controller.send();
  await turn();
  f.controller.setDraft("newer edit");
  release({
    target,
    requestId: f.controller.getSnapshot().pending[0].input.requestId,
    admission: "admitted",
    submissionId: "one",
  });
  await sending;
  assert.equal(f.controller.getSnapshot().draft, "newer edit");
  assert.equal(f.controller.getSnapshot().pending.length, 0);
  f.controller.dispose();
});
for (const operation of ["createChat", "sendChat", "stopChat"])
  test(`${operation} never discloses when pending metadata write fails`, async () => {
    const f = fixture();
    await ready(f);
    f.controller.setDraft("retained");
    f.publish({
      ...snapshot,
      state: "running",
      run: {
        state: "running",
        stop: { target, submissionId: "one", taskId: "task" },
        text: "",
        truncated: false,
        tools: [],
      },
    });
    f.storage.fail = true;
    const before = f.calls.length;
    if (operation === "createChat") await f.controller.create("Title");
    if (operation === "sendChat") await f.controller.send();
    if (operation === "stopChat") await f.controller.stop();
    assert(!f.calls.slice(before).some((c) => c.operation === operation));
    assert(f.controller.getSnapshot().storageError);
    assert.equal(f.controller.preserve(), false);
    assert.equal(f.controller.getSnapshot().draft, "retained");
    f.controller.dispose();
  });
for (const value of [
  "{broken",
  JSON.stringify({
    version: 1,
    session: { ...context, actorId: "other" },
    selected: null,
    drafts: [],
    pending: [],
  }),
])
  test(
    "corruption/foreign context remains untouched and blocks admission on reload: " +
      value.slice(0, 12),
    async () => {
      const storage = new Storage();
      storage.value = value;
      const f = fixture(storage);
      await f.controller.start();
      await f.controller.connect();
      await f.controller.create("Do not send");
      assert(f.controller.getSnapshot().storageError);
      assert.equal(storage.value, value);
      assert(!f.calls.some((c) => c.operation === "createChat"));
      f.controller.dispose();
    },
  );
test("write failure preserves latest live edit and blocks Quit instead of claiming reload safety", async () => {
  const f = fixture();
  await ready(f);
  f.controller.setDraft("saved");
  f.storage.fail = true;
  f.controller.setDraft("latest live text");
  assert.equal(f.controller.getSnapshot().draft, "latest live text");
  assert.equal(f.controller.preserve(), false);
  assert(JSON.parse(f.storage.value!).drafts.some((d: { text: string }) => d.text === "saved"));
  f.controller.dispose();
});
test("same-input retry queries first, keeps original Create/Send/Stop identities, and never adopts successor", async () => {
  const f = fixture();
  await ready(f);
  for (const op of ["createChat", "sendChat", "stopChat"])
    f.answers.set(op, async () => {
      throw failure();
    });
  await f.controller.create("Original title");
  f.controller.setDraft("Original message");
  await f.controller.send();
  const old = { target, submissionId: "original-submission", taskId: "original-task" };
  f.publish({
    ...snapshot,
    state: "running",
    run: { state: "running", stop: old, text: "", truncated: false, tools: [] },
  });
  await f.controller.stop();
  const pending = structuredClone(f.controller.getSnapshot().pending);
  f.publish({
    ...snapshot,
    state: "running",
    run: {
      state: "running",
      stop: { target, submissionId: "later", taskId: "successor" },
      text: "",
      truncated: false,
      tools: [],
    },
  });
  for (const p of pending) {
    const before = f.calls.length;
    await f.controller.retry(p.input.requestId);
    const c = f.calls.slice(before);
    assert(c[0].operation.startsWith("get") || c[0].operation === "listChats");
    assert.deepEqual(c.at(-1), { operation: p.operation, input: p.input });
  }
  assert.deepEqual(
    f.controller.getSnapshot().pending.map((p) => p.input),
    pending.map((p) => p.input),
  );
  f.controller.dispose();
});
test("pending Send does not block captured Stop or status and detach never stops work", async () => {
  const f = fixture();
  await ready(f);
  f.controller.setDraft("wait");
  let release!: (v: unknown) => void;
  f.answers.set("sendChat", () => new Promise((r) => (release = r)));
  const sending = f.controller.send();
  await turn();
  f.publish({
    ...snapshot,
    state: "running",
    run: {
      state: "running",
      stop: { target, submissionId: "one", taskId: "task" },
      text: "live",
      truncated: false,
      tools: [],
    },
  });
  await f.controller.stop();
  assert(f.calls.some((c) => c.operation === "stopChat"));
  const count = f.calls.filter((c) => c.operation === "stopChat").length;
  f.controller.closeView();
  assert.equal(f.subscriptions, 0);
  f.controller.dispose();
  assert.equal(f.calls.filter((c) => c.operation === "stopChat").length, count);
  release({ target, requestId: "request-2", admission: "reserved", submissionId: null });
  await sending;
});
test("read-only admitted lookup resolves without Send; foreign storage writes are never overwritten", async () => {
  const f = fixture();
  await ready(f);
  f.controller.setDraft("Original");
  f.answers.set("sendChat", async () => {
    throw failure();
  });
  await f.controller.send();
  const p = f.controller.getSnapshot().pending[0];
  f.answers.set("getChatSend", async () => ({
    target,
    requestId: p.input.requestId,
    admission: "admitted",
    submissionId: "one",
  }));
  f.controller.setDraft("newer");
  await f.controller.query(p.input.requestId);
  assert.equal(f.controller.getSnapshot().draft, "newer");
  assert.equal(f.calls.filter((c) => c.operation === "sendChat").length, 1);
  f.storage.value = "external change";
  f.controller.setDraft("third");
  assert.equal(f.storage.value, "external change");
  assert(f.controller.getSnapshot().storageError);
  f.controller.dispose();
});
test("replacement watch snapshots and one older page keep output bounded", async () => {
  const f = fixture();
  await ready(f);
  for (let i = 0; i < 500; i++)
    f.publish({
      ...snapshot,
      entries: [{ id: "entry", role: "assistant", text: String(i), truncated: false }],
    });
  assert.equal(f.controller.getSnapshot().snapshot!.entries.length, 1);
  assert.equal(f.controller.getSnapshot().snapshot!.entries[0].text, "499");
  f.answers.set("getChatHistory", async () => ({
    entries: Array.from({ length: 32 }, (_, i) => ({
      id: "older-" + i,
      role: "user",
      text: "bounded",
      truncated: false,
    })),
    olderCursor: "next",
  }));
  f.publish({ ...snapshot, olderCursor: "page" });
  for (let i = 0; i < 4; i++) await f.controller.older();
  assert.equal(f.controller.getSnapshot().older.length, 32);
  f.controller.dispose();
});
test("bounds reject oversized/invalid Unicode input without replacing retained draft or issuing Send", async () => {
  const f = fixture();
  await ready(f);
  f.controller.setDraft("keep");
  f.controller.setDraft("a".repeat(32769));
  assert.equal(f.controller.getSnapshot().draft, "keep");
  f.controller.setDraft("\ud800");
  assert.equal(f.controller.getSnapshot().draft, "keep");
  f.controller.dispose();
});
test("Create and captured Stop are written before disclosure; lost replies recover exact inputs after reload", async () => {
  const f = fixture();
  await ready(f);
  const stop = { target, submissionId: "saved-submission", taskId: null };
  for (const op of ["createChat", "stopChat"])
    f.answers.set(op, async (input) => {
      assert.deepEqual(JSON.parse(f.storage.value!).pending.at(-1).input, input);
      throw failure();
    });
  await f.controller.create("Preserved creation");
  f.publish({
    ...snapshot,
    state: "running",
    run: { state: "running", stop, text: "", truncated: false, tools: [] },
  });
  await f.controller.stop();
  const retained = structuredClone(f.controller.getSnapshot().pending);
  f.controller.dispose();
  const next = new ChatProofController(f.chat, f.connection, context, f.storage);
  assert.deepEqual(next.getSnapshot().pending, retained);
  next.dispose();
});
test("hide/detach releases observations, resume is read-only, and draft capacity failure blocks Quit", async () => {
  const f = fixture();
  await ready(f);
  f.controller.detach();
  assert.equal(f.subscriptions, 0);
  await f.controller.start();
  assert.equal(f.subscriptions, 1);
  assert(!f.calls.some((c) => ["sendChat", "stopChat"].includes(c.operation)));
  for (let i = 0; i < 32; i++) {
    await f.controller.select({ ...target, conversationId: "draft-" + i });
    f.controller.setDraft("retained-" + i);
  }
  await f.controller.select({ ...target, conversationId: "overflow" });
  f.controller.setDraft("latest live overflow");
  assert.equal(f.controller.getSnapshot().draft, "latest live overflow");
  assert(f.controller.getSnapshot().storageError);
  assert.equal(f.controller.preserve(), false);
  assert.equal(JSON.parse(f.storage.value!).drafts.length, 32);
  f.controller.dispose();
});
for (const operation of ["createChat", "sendChat", "stopChat"] as const)
  test(`${operation} retains the captured identity when Disconnect makes a dispatched reply Unavailable`, async () => {
    const f = fixture();
    await ready(f);
    f.controller.setDraft("captured before disconnect");
    f.publish({
      ...snapshot,
      state: "running",
      run: {
        state: "running",
        stop: { target, submissionId: "admitted", taskId: "captured-task" },
        text: "live",
        truncated: false,
        tools: [],
      },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    f.answers.set(operation, async () => {
      await gate;
      throw new ApplicationError({
        code: "Unavailable",
        message: "Connection generation gone after dispatch",
      });
    });
    const call =
      operation === "createChat"
        ? f.controller.create("Captured create")
        : operation === "sendChat"
          ? f.controller.send()
          : f.controller.stop();
    await turn();
    const original = structuredClone(f.controller.getSnapshot().pending[0]);
    await f.controller.disconnect();
    release();
    await call;
    assert.deepEqual(f.controller.getSnapshot().pending[0].input, original.input);
    f.controller.dispose();
    const next = new ChatProofController(f.chat, f.connection, context, f.storage);
    await next.start();
    await next.connect();
    await turn();
    assert.deepEqual(next.getSnapshot().pending[0].input, original.input);
    assert.equal(f.calls.filter((c) => c.operation === operation).length, 1);
    await next.retry(original.input.requestId);
    assert.deepEqual(
      f.calls.filter((c) => c.operation === operation).at(-1)!.input,
      original.input,
    );
    next.dispose();
  });

for (const operation of ["createChat", "sendChat", "stopChat"] as const)
  for (const duringQuery of [false, true])
    for (const failsWrite of [false, true])
      test(`${operation} retry vetoes ${failsWrite ? "unwritable" : "changed"} local storage ${duringQuery ? "during query" : "before retry"} before mutating redisclosure`, async () => {
        const f = fixture();
        await ready(f);
        f.controller.setDraft("captured draft");
        f.answers.set(operation, async (input) => {
          if (operation === "sendChat")
            return {
              target,
              requestId: (input as ChatCommands["sendChat"]["input"]).requestId,
              admission: "reserved",
              submissionId: null,
            };
          throw failure();
        });
        if (operation === "createChat") await f.controller.create("Captured title");
        else if (operation === "sendChat") await f.controller.send();
        else {
          f.publish({
            ...snapshot,
            state: "running",
            run: {
              state: "running",
              stop: { target, submissionId: "original-submission", taskId: "original-task" },
              text: "live",
              truncated: false,
              tools: [],
            },
          });
          await f.controller.stop();
        }
        f.controller.setDraft("newer live edit");
        const retained = structuredClone(f.controller.getSnapshot().pending[0]),
          original = JSON.parse(f.storage.value!);
        original.drafts[0].text = "newer externally published edit";
        const replacement = failsWrite ? f.storage.value : JSON.stringify(original);
        const breakStorage = () => {
          if (failsWrite) f.storage.fail = true;
          else f.storage.value = replacement;
        };
        const query =
          operation === "createChat"
            ? "listChats"
            : operation === "sendChat"
              ? "getChatSend"
              : "getChat";
        f.answers.set(query, async () => {
          if (duringQuery) breakStorage();
          return operation === "createChat"
            ? { conversations: [summary], nextCursor: null }
            : operation === "sendChat"
              ? {
                  target,
                  requestId: retained.input.requestId,
                  admission: "reserved",
                  submissionId: null,
                }
              : snapshot;
        });
        f.answers.delete(operation);
        if (!duringQuery) breakStorage();
        const before = f.calls.filter((c) => c.operation === operation).length;
        await f.controller.retry(retained.input.requestId);
        assert.equal(
          f.calls.filter((c) => c.operation === operation).length,
          before,
          "metadata preservation must veto before the remote mutation",
        );
        assert.equal(f.storage.value, replacement);
        assert.deepEqual(f.controller.getSnapshot().pending[0].input, retained.input);
        assert.equal(f.controller.getSnapshot().draft, "newer live edit");
        assert(f.controller.getSnapshot().storageError);
        const queries = f.calls.filter((c) => c.operation === query).length;
        await f.controller.query(retained.input.requestId);
        assert(
          f.calls.filter((c) => c.operation === query).length > queries,
          "safe read-only query remains available",
        );
        assert.equal(f.calls.filter((c) => c.operation === operation).length, before);
        f.controller.dispose();
      });

for (const release of ["detach", "dispose"] as const)
  test(`a delayed Create reply after ${release} records success without restarting observations`, async () => {
    const f = fixture();
    await ready(f);
    let reply!: (value: unknown) => void;
    f.answers.set("createChat", () => new Promise(resolve => { reply = resolve; }));
    const pending = f.controller.create("Delayed creation");
    const original = f.controller.getSnapshot().pending[0];
    f.controller[release]();
    assert.equal(f.subscriptions, 0);
    const reads = f.calls.filter(c => c.operation === "getChat").length;
    reply({ requestId: original.input.requestId, conversation: summary });
    await pending;
    assert.equal(f.subscriptions, 0);
    assert.equal(f.calls.filter(c => c.operation === "getChat").length, reads);
    const saved = JSON.parse(f.storage.value!);
    assert.deepEqual(saved.selected, target);
    assert.deepEqual(saved.pending, []);
    if (release === "detach") {
      await f.controller.start();
      assert.equal(f.subscriptions, 1);
      assert.equal(f.calls.filter(c => c.operation === "createChat").length, 1);
    }
    f.controller.dispose();
  });
