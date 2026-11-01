// Copy into a temporary npm project; installation/run commands are in the adjacent evidence note.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ConversationBusy, createRegistry, defineDocFamily, defineExtension, defineTool, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";

globalThis.fetch = () => { throw new Error("Network disabled in this faux-only probe"); };

async function deadline(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

const Receipt = defineDocFamily({
  kind: "probe.receipt", version: 1, scope: "session", family: true,
  initial: (binding) => ({ binding, submissionId: null }), checkpointWhen: () => true,
});

async function reserve(harness, key, binding) {
  return harness.commit(async (tx) => {
    const receipt = await tx.doc(Receipt, key, binding);
    assert.deepEqual(JSON.parse(JSON.stringify(receipt.binding)), binding);
  }, context);
}

function stack(execute, responses) {
  const faux = fauxProvider({ tokensPerSecond: 10_000, tokenSize: { min: 32, max: 32 } });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "probe", tools: [defineTool({
    name: "counted", description: "Count a controlled local invocation", parameters: Type.Object({}), execute,
  })] }));
  return {
    faux, model: { provider: faux.provider.id, modelId: faux.getModel().id },
    options: {
      models, registry, settings: {
        progress: { partialIntervalMs: 1, outputIntervalMs: 1 },
        compaction: { enabled: false }, retry: { enabled: false },
      },
    },
  };
}

async function admissionProbe(directory) {
  let tools = 0;
  const execute = async () => { tools++; return { output: [{ type: "text", text: "counted" }] }; };
  const first = stack(execute, [
    fauxAssistantMessage(fauxToolCall("counted", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("completed"),
  ]);
  const path = join(directory, "admission.sqlite");
  let harness = await Harness.open(await openNodeSqliteStorage(path, { busyTimeoutMs: 30 }), first.options, context);
  try {
    const conversation = await harness.createConversation({
      ownership: { kind: "ownerless" }, agent: { model: first.model },
    }, context);
    const binding = {
      actor: "probe-actor", host: "probe-host", store: "probe-store",
      conversationId: conversation.id, requestId: "lost-response", payload: "original",
    };
    const key = `${conversation.id}/${binding.requestId}`;
    await reserve(harness, key, binding);
    // Do not publish the returned ID into the receipt: simulate the lost admission response gap.
    const admitted = await conversation.submit({ type: "input", content: binding.payload, requestId: binding.requestId }, context);
    assert.equal((await deadline(admitted.wait(context), "admission completion")).status, "done");
    assert.equal(tools, 1);
    assert.equal(first.faux.state.callCount, 2);
    await harness.close(context);

    const reopened = stack(execute, []);
    harness = await Harness.open(await openNodeSqliteStorage(path, { busyTimeoutMs: 30 }), reopened.options, context);
    harness.resume();
    assert.equal((await harness.snapshot(Receipt, key, context)).submissionId, null);
    const recovered = await harness.commit(async (tx) => {
      const record = await tx.submissionByRequest(conversation.id, binding.requestId);
      assert.equal(record.id, admitted.id);
      assert.equal(record.status, "done");
      const receipt = await tx.doc(Receipt, key, binding);
      assert.deepEqual(JSON.parse(JSON.stringify(receipt.binding)), binding);
      assert.equal(receipt.submissionId, null);
      receipt.submissionId = record.id;
      return record;
    }, context);
    await assert.rejects(reserve(harness, key, { ...binding, payload: "changed" }), { code: "ERR_ASSERTION" });
    assert.deepEqual((await harness.snapshot(Receipt, key, context)).binding, binding);
    assert.equal((await (await harness.submission(recovered.id, context)).status(context)).status, "done");
    assert.equal(tools, 1);
    assert.equal(reopened.faux.state.callCount, 0);
    return { submitCalls: 1, firstModelCalls: 2, reopenedModelCalls: 0, toolCalls: tools, recoveredSubmission: recovered.id, changedPayloadRejected: true };
  } finally { await harness.close(context); }
}

async function observationProbe(directory) {
  const toolEntered = Promise.withResolvers(), releaseTool = Promise.withResolvers();
  const nextRequest = Promise.withResolvers(), releaseModel = Promise.withResolvers();
  const outputObserved = Promise.withResolvers();
  let tools = 0, harness, unsubscribe = () => {}, disposed = false;
  let dirty = false, running = false, refreshPromise = Promise.resolve();
  let callbacks = 0, refreshes = 0, maxBytes = 0, maxEntries = 0, sawPartial = false;
  let refreshError;
  const controlled = stack(async (_, api, ctx) => {
    tools++;
    api.output("x".repeat(4096));
    await api.details({ phase: "held", unboundedDetailNotForwarded: "d".repeat(4096) }, ctx);
    toolEntered.resolve();
    await releaseTool.promise;
    return { output: [{ type: "text", text: "released" }] };
  }, [
    fauxAssistantMessage([fauxText("partial-".repeat(64)), fauxToolCall("counted", {})], { stopReason: "toolUse" }),
    async () => { nextRequest.resolve(); await releaseModel.promise; return fauxAssistantMessage("final-".repeat(128)); },
  ]);
  try {
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "observation.sqlite"), { busyTimeoutMs: 30 }), controlled.options, context);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: controlled.model } }, context);
    const refresh = async () => {
      while (dirty && !disposed) {
        dirty = false;
        const page = await conversation.entries({}, 2, undefined, context);
        const live = await harness.snapshot(LiveDoc, conversation.id, context);
        const partial = live.generation?.message?.content?.find((part) => part.type === "text")?.text ?? "";
        const output = live.tools?.[0]?.output ?? "";
        const projection = {
          entries: page.items.map((entry) => {
            const content = entry.model?.[0]?.content;
            const text = typeof content === "string" ? content : content?.find((part) => part.type === "text")?.text ?? "";
            return { id: entry.id, kind: entry.kind.slice(0, 32), text: text.slice(0, 64) };
          }),
          taskId: live.run?.taskId ?? null,
          partial: partial.slice(0, 64), output: output.slice(0, 64),
          tool: live.tools?.[0]?.status ?? null,
        };
        refreshes++;
        maxEntries = Math.max(maxEntries, projection.entries.length);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(projection)));
        sawPartial ||= partial.length > 0;
        assert(projection.entries.length <= 2);
        assert(Buffer.byteLength(JSON.stringify(projection)) <= 512);
        if (output.length > 64) outputObserved.resolve();
      }
    };
    const invalidate = () => {
      dirty = true;
      if (!running) {
        running = true;
        refreshPromise = new Promise((resolve) => setImmediate(resolve))
          .then(refresh).catch((error) => { refreshError = error; outputObserved.reject(error); })
          .finally(() => { running = false; if (dirty && !disposed) invalidate(); });
      }
    };
    unsubscribe = harness.subscribeCommits((publication) => {
      if (publication.changes.some((change) => (change.value?.conversationId ?? change.conversationId) === conversation.id)) {
        callbacks++;
        invalidate();
      }
    });
    invalidate();
    const submission = await conversation.submit({ type: "input", content: "observe", requestId: "observe" }, context);
    await deadline(toolEntered.promise, "held tool");
    await deadline(outputObserved.promise, "bounded tool output projection");
    const before = (await harness.snapshot(LiveDoc, conversation.id, context)).run;
    assert(before.inputs.includes(submission.id));
    await assert.rejects(conversation.submit({ type: "input", content: "reject while busy", requestId: "rejected", whenBusy: "reject" }, context), ConversationBusy);
    assert.equal(await harness.commit((tx) => tx.submissionByRequest(conversation.id, "rejected"), context), undefined);
    disposed = true;
    unsubscribe();
    await refreshPromise;
    assert.equal(refreshError, undefined);
    const atUnsubscribe = callbacks;
    releaseTool.resolve();
    await deadline(nextRequest.promise, "successor generation");
    const after = (await harness.snapshot(LiveDoc, conversation.id, context)).run;
    assert.notEqual(after.taskId, before.taskId);
    assert(after.inputs.includes(submission.id));
    assert.equal(callbacks, atUnsubscribe);
    releaseModel.resolve();
    assert.equal((await deadline(submission.wait(context), "detached completion")).status, "done");
    assert.equal(callbacks, atUnsubscribe);
    assert.equal(controlled.faux.state.callCount, 2);
    assert.equal(tools, 1);
    assert(sawPartial);
    return { callbacks, refreshes, maxBytes, maxEntries, sawPartial, taskBefore: before.taskId, taskAfter: after.taskId, submissionId: submission.id, busyRejectedWithoutAdmission: true, completedAfterUnsubscribe: true };
  } finally {
    disposed = true;
    unsubscribe();
    releaseTool.resolve();
    releaseModel.resolve();
    await refreshPromise;
    await harness?.close(context);
  }
}

async function lockChild(path) {
  let database, storage;
  const started = performance.now();
  try {
    database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 30 });
    await database.exec("PRAGMA locking_mode=EXCLUSIVE");
    assert.equal((await database.get("PRAGMA locking_mode")).locking_mode, "exclusive");
    // Force a real write; table contents are never consulted as an ownership sentinel.
    await database.transaction(async (tx) => {
      await tx.exec("CREATE TABLE IF NOT EXISTS probe_lock_acquisition (value INTEGER)");
      await tx.run("INSERT INTO probe_lock_acquisition VALUES (?)", 1);
    });
    storage = await SqliteStorage.open(database);
    process.send({ ready: true });
    await once(process, "message");
    await storage.close(context);
    process.disconnect();
  } catch (error) {
    await database?.close().catch(() => {});
    process.send({ ready: false, message: error.message, code: error.code, errcode: error.errcode, elapsedMs: Math.round(performance.now() - started) });
    process.exitCode = 2;
    process.disconnect();
  }
}

async function ownershipProbe(directory) {
  const children = [];
  const launch = async () => {
    const child = fork(fileURLToPath(import.meta.url), ["lock-child", join(directory, "ownership.sqlite")], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const exit = once(child, "exit");
    children.push({ child, exit });
    const [message] = await deadline(once(child, "message"), "lock child result");
    return { child, exit, message };
  };
  try {
    const owner = await launch();
    assert.equal(owner.message.ready, true);
    const contender = await launch();
    assert.equal(contender.message.ready, false);
    assert.match(contender.message.message, /locked|busy/i);
    assert.equal((await deadline(contender.exit, "contender exit"))[0], 2);
    owner.child.kill("SIGKILL");
    assert.equal((await deadline(owner.exit, "owner crash"))[1], "SIGKILL");
    const recovery = await launch();
    assert.equal(recovery.message.ready, true);
    recovery.child.send("close");
    assert.equal((await deadline(recovery.exit, "recovery close"))[0], 0);
    return { busyTimeoutMs: 30, contender: contender.message, recoveredAfterSIGKILL: true };
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ exit }) => deadline(exit, "child cleanup")));
  }
}

if (process.argv[2] === "lock-child") {
  await lockChild(process.argv[3]);
} else {
  const stateDirectory = await mkdtemp(join(tmpdir(), "pi-durable-state-"));
  const result = { node: process.version, platform: process.platform, arch: process.arch, stateDirectory };
  try {
    result.admission = await admissionProbe(stateDirectory);
    result.observation = await observationProbe(stateDirectory);
    result.ownership = await ownershipProbe(stateDirectory);
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
  console.log(JSON.stringify({ ...result, stateRemovedOnExit: true }, null, 2));
}
