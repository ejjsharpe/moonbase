import { test, expect } from "vite-plus/test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableState } from "./durable-state";
import { FileOperationJournal, type Intent } from "./file-operation-journal";
const intent: Intent = { root: "/checkout", checkoutIdentity: "checkout", source: "a.txt", destination: "b.txt", kind: "move", identity: "source" };
test("SQLite journal clears durably and leaves previous JSON untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-journal-"));
  const database = new DurableState(join(dir, "db"));
  try {
    const owner = await database.ready, file = join(dir, "intent.json");
    await writeFile(file, "previous store");
    const journal = new FileOperationJournal(file, owner, database);
    expect(await journal.readIntent()).toBe(null);
    await journal.writeIntent(intent);
    expect(await new FileOperationJournal(file, owner, database).readIntent()).toEqual(intent);
    await journal.writeIntent(null);
    expect(await new FileOperationJournal(file, owner, database).readIntent()).toBe(null);
    expect(await readFile(file, "utf8")).toBe("previous store");
  } finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
});
test.each([{ ...intent, root: "relative" }, { ...intent, source: "../a" }, { ...intent, destination: ".GIT/config" }, { ...intent, kind: "save", completed: true, saveText: "edit" }, { ...intent, completed: "yes" }, { ...intent, kind: "copy", copies: [{ root: "/checkout", path: "outside", text: "edit", disk: { text: "disk", version: "v" } }] }, { ...intent, kind: "save", saveText: "edit", savedDisk: { text: "disk" } }])("invalid SQLite intent remains available for inspection: %j", async value => {
  const dir = await mkdtemp(join(tmpdir(), "escode-journal-"));
  const database = new DurableState(join(dir, "db"));
  try {
    const owner = await database.ready;
    await database.recoveryWrite(owner.clientId, "intent", value, 0);
    await expect(new FileOperationJournal(join(dir, "unused"), owner, database).readIntent()).rejects.toThrow("Invalid operation journal");
    expect((await database.recoveryRead(owner.clientId, "intent")).body).toEqual(value);
  } finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("SQLite journal serializes concurrent writes and recovers after a failed write", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "escode-journal-"));
  const database = new DurableState(join(dir, "db"));
  try {
    const owner = await database.ready;
    const fault = new DatabaseSync(join(dir, "db/state.sqlite"));
    try {
      const journal = new FileOperationJournal(join(dir, "unused"), owner, database);
      fault.exec("CREATE TRIGGER deny_intent BEFORE INSERT ON client_recovery BEGIN SELECT RAISE(ABORT,'journal unavailable'); END");
      await expect(journal.writeIntent(intent)).rejects.toThrow("journal unavailable");
      fault.exec("DROP TRIGGER deny_intent");
      const writes = Array.from({ length: 12 }, (_, i) => journal.writeIntent({ ...intent, identity: String(i) }));
      const read = journal.readIntent();
      await Promise.all(writes);
      expect((await read)?.identity).toBe("11");
      expect((await new FileOperationJournal(join(dir, "unused"), owner, database).readIntent())?.identity).toBe("11");
    } finally { fault.close(); }
  } finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
});
