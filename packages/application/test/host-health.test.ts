import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import { Cause, Effect, Exit } from "effect";
import { ApplicationError, type ApplicationErrorCode } from "../src/client.ts";
import { chatHostVersion, chatProtocolVersion } from "../src/host-client.ts";
import { checkHostHealth, type ChatHostEndpoint } from "../src/host-health.ts";

const expected = { hostId: "host-a", storeId: "store-a" };
const health = { ...expected, protocol: chatProtocolVersion, version: chatHostVersion, capabilities: ["chat-v0"] };
const token = "synthetic-health-test-token";
async function endpoint(t: TestContext, handler: RequestListener): Promise<ChatHostEndpoint> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address(); assert(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`, token, expected };
}
async function fails(input: ChatHostEndpoint, code: ApplicationErrorCode) {
  const result = await Effect.runPromiseExit(checkHostHealth(input));
  assert(Exit.isFailure(result), "health must fail");
  const failures = result.cause.reasons.flatMap(reason => Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : []);
  assert(failures.some(error => ApplicationError.is(error) && error.code === code), `expected ${code}`);
}

test("health authenticates the loopback request and retains the exact configured identity", async t => {
  let requests = 0;
  const input = await endpoint(t, (request, response) => {
    requests++; assert.equal(request.method, "GET"); assert.equal(request.url, "/v1/health");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(health));
  });
  assert.deepEqual(await Effect.runPromise(checkHostHealth(input)), health); assert.equal(requests, 1);
});

test("wrong authentication is a typed rejection without including the token in errors", async t => {
  const input = await endpoint(t, (_request, response) => { response.writeHead(401); response.end("private server detail"); });
  await fails(input, "Unauthorized");
  const result = await Effect.runPromiseExit(checkHostHealth(input));
  assert(Exit.isFailure(result)); assert(!String(result.cause).includes(token)); assert(!String(result.cause).includes("private server detail"));
});

test("host, store, protocol, version and required capability mismatches fail closed", async t => {
  let value: unknown = health;
  const input = await endpoint(t, (_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); });
  for (const changed of [{ hostId: "other" }, { storeId: "other" }, { protocol: 2 }, { version: "next" }, { capabilities: [] }]) {
    value = { ...health, ...changed }; await fails(input, "Incompatible");
  }
  value = { ...health, capabilities: Array(17).fill("chat-v0") }; await fails(input, "Incompatible");
});

test("invalid endpoint configuration is rejected before any network request", async t => {
  let requests = 0;
  const input = await endpoint(t, (_request, response) => { requests++; response.end(); });
  for (const origin of ["https://127.0.0.1", "http://example.invalid", `${input.origin}/unexpected`, `${input.origin}?token=x`, `${input.origin}#fragment`, input.origin.replace("//", "//user:pass@")])
    await fails({ ...input, origin }, "InvalidInput");
  await fails({ ...input, token: "" }, "InvalidInput");
  await fails({ ...input, token: token + "\r\n" }, "InvalidInput");
  await fails({ ...input, expected: { ...expected, storeId: "" } }, "InvalidInput");
  assert.equal(requests, 0);
});

test("redirects are not followed with the host credential", async t => {
  let redirectedRequests = 0;
  const input = await endpoint(t, (request, response) => {
    if (request.url === "/redirected") { redirectedRequests++; response.end(JSON.stringify(health)); }
    else { response.writeHead(302, { Location: "/redirected" }); response.end(); }
  });
  await fails(input, "Unavailable"); assert.equal(redirectedRequests, 0);
});

test("health bounds actual response bytes and rejects malformed or non-JSON data", async t => {
  let body: string | Buffer = "{}", type = "text/html";
  const input = await endpoint(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": type });
    response.write(typeof body === "string" ? body.slice(0, 4096) : body.subarray(0, 4096));
    response.end(typeof body === "string" ? body.slice(4096) : body.subarray(4096));
  });
  await fails(input, "Incompatible");
  type = "application/json"; body = "{"; await fails(input, "Incompatible");
  body = Buffer.from([0xff]); await fails(input, "Incompatible");
  body = JSON.stringify({ ...health, padding: "x".repeat(9000) }); await fails(input, "Incompatible");
});

test("cancelling health closes an in-flight response without owning the server", { timeout: 10000 }, async t => {
  let enter!: () => void, close!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), closed = new Promise<void>(resolve => { close = resolve; });
  const input = await endpoint(t, (_request, response) => {
    response.on("close", close);
    response.writeHead(200, { "Content-Type": "application/json" }); response.write("{"); enter();
  });
  const abort = new AbortController();
  const result = Effect.runPromiseExit(checkHostHealth(input), { signal: abort.signal });
  await entered; abort.abort();
  const exit = await result; assert(Exit.isFailure(exit)); assert(Cause.hasInterruptsOnly(exit.cause));
  await closed;
});

test("a stalled health body reaches its deadline and releases the response", { timeout: 10000 }, async t => {
  let close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const input = await endpoint(t, (_request, response) => {
    response.on("close", close); response.writeHead(200, { "Content-Type": "application/json" }); response.write("{");
  });
  await fails(input, "Unavailable"); await closed;
});
