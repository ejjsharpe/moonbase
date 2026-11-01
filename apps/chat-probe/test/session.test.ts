import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatClient } from "@moonbase/application/chat-client";
import type { ConnectionClient } from "@moonbase/application/connection-client";
import { ApplicationError } from "@moonbase/application/client";
import { ProofSession } from "../src/session.ts";
import { browserClients, type ChatBridge, type Reply } from "../src/wire.ts";
const context = { host: { hostId: "host", storeId: "store" }, actorId: "owner" },
  target = { ...context, conversationId: "saved" };
function fixture() {
  let calls = 0,
    observers = 0,
    stop = 0;
  const chat: ChatClient = {
    command: async (_op, _input, options) => {
      calls++;
      if (_op === "sendChat")
        throw new ApplicationError({ code: "Uncertain", message: "Admission response lost" });
      if (_op === "getChatHistory")
        return await new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => reject(new ApplicationError({ code: "Cancelled", message: "Wait cancelled" })),
            { once: true },
          ),
        );
      return null as never;
    },
    watch: () => {
      observers++;
      return () => {
        observers--;
      };
    },
  };
  const connection: ConnectionClient = {
    command: async () => {
      stop++;
      return undefined as never;
    },
    watch: () => () => {},
  };
  const owner = new ProofSession(chat, connection, context, () => {});
  return {
    owner,
    get calls() {
      return calls;
    },
    get observers() {
      return observers;
    },
    get stop() {
      return stop;
    },
  };
}
test("IPC rejects unknown fields/operations/foreign authority before dispatch", async () => {
  const f = fixture();
  for (const args of [
    ["chat", "unknown", {}],
    ["chat", "constructor", {}],
    ["chat", "__proto__", {}],
    ["connection", "constructor", {}],
    ["chat", "getChat", { target, privateKey: "x" }],
    ["chat", "getChat", { target: { ...target, actorId: "other" } }],
    ["chat", "getChat", { target: { ...target, host: { ...context.host, storeId: "other" } } }],
    ["connection", "connect", { profileId: "id", destination: "injected" }],
    ["unknown", "getChat", { target }],
  ])
    await assert.rejects(f.owner.call(args[0], args[1], args[2], "id"));
  assert.equal(f.calls, 0);
  assert.equal(f.stop, 0);
});
test("public bridge preserves Uncertain and exact pending payload; preaborted calls do not dispatch", async () => {
  const f = fixture();
  const bridge: ChatBridge = {
    context: async () => context,
    call: (kind, op, input, id) => f.owner.call(kind, op, input, id),
    cancel: (id) => f.owner.cancel(id),
    events: () => () => {},
    quit: () => () => {},
    consent: () => {},
    ready: () => {},
  };
  const client = browserClients(bridge).chat,
    input = { target, requestId: "original", text: "captured" };
  await assert.rejects(client.command("sendChat", input), { code: "Uncertain" });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(client.command("sendChat", input, { signal: abort.signal }), {
    code: "Cancelled",
  });
  assert.equal(f.calls, 1);
  f.owner.dispose();
});
test("IPC cancellation/disposal releases only owned waiters/observations, never Stop or Disconnect", async () => {
  const f = fixture();
  await f.owner.call("watch-chat", "", { target }, "watch");
  assert.equal(f.observers, 1);
  const pending = f.owner.call("chat", "getChatHistory", { target, cursor: "page" }, "wait");
  f.owner.cancel("wait");
  const reply = await pending;
  assert(!reply.ok);
  assert.equal(reply.error.code, "Cancelled");
  f.owner.dispose();
  assert.equal(f.observers, 0);
  assert.equal(f.owner.count, 0);
  assert.equal(f.stop, 0);
});
