import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, configure, createRegistry, defineDocFamily, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

globalThis.fetch = () => { throw Error("No network in faux-only creation probe"); };
const Request = defineDocFamily({ kind: "probe.creation-request", version: 1, scope: "session", family: true,
  initial: binding => ({ binding, conversationId: null }), checkpointWhen: () => true });
const Metadata = defineDocFamily({ kind: "probe.creation-metadata", version: 1, scope: "conversation", family: true,
  initial: metadata => ({ ...metadata }), checkpointWhen: () => true });
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const model = { provider: faux.provider.id, modelId: faux.getModel().id }, cwd = "/controlled/fixed";
const options = { models, registry: createRegistry(), settings: { retry: { enabled: false }, compaction: { enabled: false } } };
const directory = await mkdtemp(join(tmpdir(), "moonbase-atomic-create-")), file = join(directory, "store.sqlite");
let harness = await Harness.open(await openNodeSqliteStorage(file, { busyTimeoutMs: 30 }), options, context);
const binding = { actorId: "personal", hostId: "host", storeId: "store", requestId: "create-one", operation: "createChat", title: "Original" };
async function create(input, rollback = false) {
  return harness.commit(async tx => {
    const request = await tx.doc(Request, JSON.stringify([input.actorId, input.requestId]), input);
    assert.deepEqual(JSON.parse(JSON.stringify(request.binding)), input);
    if (request.conversationId !== null) return request.conversationId;
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, conversation.id, { model, cwd });
    await tx.doc(Metadata, conversation.id, "metadata", { actorId: input.actorId, title: input.title, cwd, model: `${model.provider}/${model.modelId}` });
    request.conversationId = conversation.id;
    if (rollback) throw Error("controlled rollback");
    return conversation.id;
  }, context);
}
try {
  const id = await create(binding);
  assert.equal(await create(binding), id);
  assert.deepEqual(await Promise.all([create(binding), create(binding)]), [id, id]);
  await assert.rejects(create({ ...binding, title: "Changed" }), { code: "ERR_ASSERTION" });
  const rolledBack = { ...binding, requestId: "rollback" };
  await assert.rejects(create(rolledBack, true), /controlled rollback/);
  assert.equal(await harness.snapshot(Request, JSON.stringify([rolledBack.actorId, rolledBack.requestId]), context), undefined);
  assert.equal((await harness.commit(tx => tx.scanConversations({}, 32), context)).items.length, 1);
  assert.equal((await harness.snapshot(Metadata, id, "metadata", context)).title, "Original");
  assert.deepEqual((await harness.snapshot(AgentDoc, id, context)).model, model);
  assert.equal((await harness.snapshot(AgentDoc, id, context)).cwd, cwd);
  await harness.close(context);
  harness = await Harness.open(await openNodeSqliteStorage(file, { busyTimeoutMs: 30 }), options, context);
  assert.equal(await create(binding), id);
  assert.equal((await harness.commit(tx => tx.scanConversations({}, 32), context)).items.length, 1);
  assert.equal(faux.state.callCount, 0);
  console.log(JSON.stringify({ pass: true, conversationId: id, concurrentRetries: 2, changedPayloadRejected: true, creationAndReceiptRolledBack: true, restartedOriginalReceipt: true, modelCalls: faux.state.callCount }));
} finally { await harness.close(context); await rm(directory, { recursive: true, force: true }); }
