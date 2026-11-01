import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Checkout } from "./project";
import { Workspace } from "./workspace";
import { FileOperationJournal, type Intent } from "./file-operation-journal";
export type OperationResult = {
  applied: boolean;
  message: string;
  intent?: Intent;
  persistencePending?: boolean;
};
export type SavedFile = { path: string; disk: import("./project").Document };
export type TrashResult = OperationResult & {
  source: string;
  conflict?: { path: string; disk: import("./project").Document };
};
import { affected, reconcile } from "./file-operation-state";
// One journal survives the disk/workspace handoff. Never infer success from absence alone.
export class FileOperations {
  private journal: FileOperationJournal;
  private pending?: Intent;
  private savedBaselines = new Map<string, { root: string; path: string; before: Set<string>; disk: import("./project").Document }>();
  private handoff?: { root: string; facts: Intent[] };
  busy = false;
  constructor(
    private workspace: Workspace,
    file: string,
    owner?: { hostId: string; clientId: string },
  ) {
    this.journal = new FileOperationJournal(file, owner ?? workspace.owner, workspace.database);
  }
  async recover(project: (root: string) => Promise<Checkout>) {
    const facts = await this.journal.readFacts();
    if (facts.length) this.handoff = { root: facts[0].root, facts };
    const record = await this.journal.readIntent();
    if (!record) {
      if (facts.length) {
        const state = await this.workspace.read();
        for (const fact of facts) reconcile(state, fact);
        await this.workspace.write(state);
      }
      return "";
    }
    this.pending = record;
    try {
      const p = await project(record.root);
      if (p.checkoutIdentity() !== record.checkoutIdentity) throw Error("Checkout replaced");
      if (record.kind === "save") {
        if (!record.completed) {
          record.savedDisk = undefined;
          const disk = await p.read(record.source);
          if (disk.text === record.saveText) record.savedDisk = disk;
          else if (p.operationIdentity(record.source) === record.identity) {
            await this.ack();
            return "Interrupted save did not replace its source; drafts retained.";
          }
        }
        if (!record.savedDisk) throw Error("Uncertain interrupted save");
        if (record.completed) await this.remember(record);
        const state = await this.workspace.read();
        reconcile(state, record);
        await this.workspace.write(state);
        await this.ack();
        return `Recovered saved baseline: ${record.root}/${record.source}. Available text retained.`;
      }
      const identity = (path: string) => {
        try {
          return p.operationIdentity(path);
        } catch {
          return "";
        }
      };
      const source = identity(record.source),
        destination = record.kind === "move" ? identity(record.destination) : "";
      if (
        record.completed ||
        (record.kind === "move" && destination === record.identity && source !== record.identity)
      ) {
        record.completed = true;
        await this.remember(record);
        const state = await this.workspace.read();
        reconcile(state, record);
        await this.workspace.write(state);
        await this.ack();
        return `Recovered ${record.kind}: ${record.root}/${record.source} → ${record.destination || "macOS Trash"}. ${record.kind === "copy" ? "Available copied drafts restored; source retained." : "Earlier text undo history was reset."}`;
      }
      if (record.kind !== "copy" && source === record.identity && destination !== record.identity) {
        await this.ack();
        return "Interrupted operation did not move its source; drafts retained.";
      }
    } catch {
      /* Unavailable or replaced checkout: retain journal and drafts. */
    }
    return `Uncertain file operation: inspect ${record.root}/${record.source} and ${record.kind === "save" ? "its last saved disk contents" : record.destination || "Finder Trash"}${record.temporary ? ` (staging: ${record.temporary})` : ""}. Available drafts retained; file mutations are blocked until the original paths can be reconciled on restart.`;
  }
  acknowledgementRoots() {
    return [...new Set((this.handoff?.facts ?? []).map(fact => fact.root))];
  }
  beginBatch(root: string) {
    this.assertIdle();
    this.handoff = { root, facts: [] };
  }
  hasBatchFacts(root: string) {
    return this.handoff?.root === root && this.handoff.facts.length > 0;
  }
  releaseEmptyBatch() {
    if (!this.handoff?.facts.length) this.handoff = undefined;
  }
  async persist(state: unknown) {
    const facts = await this.journal.readFacts();
    if (facts.length) this.handoff = { root: facts[0].root, facts };
    if (this.busy && this.pending?.kind !== "copy")
      throw Error("File operation is persisting recovery intent. Retry after completion.");
    // Apply facts inside the storage queue, including writes queued before a fact completed.
    const acknowledged = new Map<string, typeof this.savedBaselines extends Map<string, infer V> ? V : never>();
    return this.workspace.write(state, (snapshot) => {
      for (const [key, saved] of this.savedBaselines) {
        const draft = snapshot.drafts.find(d => d.root === saved.root && d.path === saved.path);
        if (!draft || draft.disk.version === saved.disk.version) acknowledged.set(key, saved);
        else if (saved.before.has(draft.disk.version)) draft.disk = saved.disk;
      }
      for (const fact of this.handoff?.facts ?? []) reconcile(snapshot, fact);
      if (this.pending?.completed) reconcile(snapshot, this.pending);
    }).then(() => { for (const [key, saved] of acknowledged) if (this.savedBaselines.get(key) === saved) this.savedBaselines.delete(key); });
  }
  private async remember(intent: Intent) {
    if (!this.handoff && intent.kind === "save") return;
    if (this.handoff?.root !== intent.root) this.handoff = { root: intent.root, facts: [] };
    if (!this.handoff.facts.some(f => f.source === intent.source && f.destination === intent.destination && f.identity === intent.identity && f.kind === intent.kind)) {
      this.handoff.facts.push(structuredClone(intent));
    }
    if (intent.kind === "move" || intent.kind === "trash")
      this.handoff.facts = await this.journal.publishFact(intent);
    else await this.journal.writeFacts(this.handoff.facts);
  }
  assertIdle(batchRoot?: string) {
    if (this.busy || this.pending || (this.handoff && this.handoff.root !== batchRoot))
      throw Error(
        "File operation pending reconciliation. Restart to reconcile actual paths; available edits are retained.",
      );
  }
  async run(
    p: Checkout,
    kind: "move" | "trash" | "copy",
    source: string,
    destination: string,
    validateOrigin: () => void = () => {},
    native?: import("./native-import").NativeImport,
  ): Promise<OperationResult> {
    this.assertIdle(p.root);
    this.busy = true;
    try {
      if (kind !== "trash" && !native) p.validateMove(source, destination);
      const intent: Intent = {
        root: p.root,
        checkoutIdentity: p.checkoutIdentity(),
        kind,
        source,
        destination,
        identity: native?.identity ?? p.operationIdentity(source),
      };
      if (kind !== "trash") {
        const state = await this.workspace.read();
        if (
          state.drafts.some(
            (d) =>
              d.root === p.root &&
              (native || !affected(d.path, source)) &&
              affected(
                d.path.normalize("NFC").toLowerCase(),
                destination.normalize("NFC").toLowerCase(),
              ),
          )
        )
          throw Error("Destination recovery drafts need preserving. Choose a free destination.");
      }
      if (kind === "copy") {
        intent.temporary = join(dirname(destination), ".escode-copy-" + randomUUID());
        const state = await this.workspace.read();
        intent.copies = native
          ? []
          : state.drafts
              .filter((d) => d.root === p.root && affected(d.path, source))
              .map((d) => ({ ...d, path: destination + d.path.slice(source.length) }));
      }
      await this.journal.writeIntent(intent);
      this.pending = intent;
      try {
        validateOrigin();
        if (kind === "copy")
          await p.copy(source, destination, intent.identity, intent.temporary!, native);
        else if (kind === "move") p.move(source, destination, intent.identity);
        else p.trash(source, intent.identity);
      } catch (error) {
        // Imports never mutate their source; Checkout.copy marks any possible publication uncertain.
        // Other operations require a still-identical source to prove a failed mutation.
        let unchanged = false;
        try {
          unchanged = native ? true : p.operationIdentity(source) === intent.identity;
        } catch {
          /* Keep uncertain intent. */
        }
        if (unchanged && !(error as { uncertain?: boolean }).uncertain) {
          await this.ack();
          throw error;
        }
        throw Error(
          `Uncertain ${kind}: inspect ${p.root}/${source} and ${destination || "Finder Trash"}${intent.temporary ? ` (staging: ${intent.temporary})` : ""}. Available edits and intent retained; restart to reconcile actual paths. ${String(error)}`,
        );
      }
      if (kind === "copy") {
        // Native success is a fact even if the destination changes before baseline reading.
        for (const draft of intent.copies ?? []) {
          try {
            draft.disk = await p.read(draft.path);
          } catch {
            /* Retain the available source baseline; ordinary Save will revalidate it. */
          }
        }
      }
      intent.completed = true;
      try {
        await this.journal.writeIntent(intent);
        await this.remember(intent);
        const state = await this.workspace.read();
        reconcile(state, intent);
        await this.workspace.write(state);
      } catch (error) {
        return {
          applied: true,
          persistencePending: true,
          intent,
          message: `${kind === "trash" ? "Moved to macOS Trash" : kind === "copy" ? "Copied" : "Moved"}; recovery persistence needs retry: ${String(error)}`,
        };
      }
      return {
        applied: true,
        intent,
        message:
          kind === "copy"
            ? native
              ? "Copied; native original retained."
              : "Copied; source edits remain unsaved."
            : kind === "move"
              ? "Moved. Earlier text undo history was reset; new edits support undo."
              : "Moved to macOS Trash.",
      };
    } finally {
      this.busy = false;
    }
  }
  async save(
    p: Checkout,
    path: string,
    text: string,
    version: string,
    validateOrigin: () => void,
  ): Promise<import("./project").SaveResult & { persistencePending?: boolean; message?: string }> {
    this.assertIdle(p.root);
    const intent: Intent = {
      root: p.root,
      checkoutIdentity: p.checkoutIdentity(),
      source: path,
      destination: "",
      kind: "save",
      identity: p.operationIdentity(path),
      saveText: text,
    };
    this.busy = true;
    try {
      await this.journal.writeIntent(intent);
      this.pending = intent;
      validateOrigin();
      const result = await p.save(path, text, version);
      if (result.kind === "conflict") {
        await this.ack();
        return result;
      }
      intent.completed = true;
      intent.savedDisk = result.disk;
      const key = JSON.stringify([p.root, path]);
      this.savedBaselines.set(key, { root: p.root, path,
        before: new Set([...(this.savedBaselines.get(key)?.before ?? []), version]), disk: result.disk });
      try {
        await this.journal.writeIntent(intent);
        await this.remember(intent);
        const state = await this.workspace.read();
        reconcile(state, intent);
        await this.workspace.write(state);
        await this.ack();
        return { ...result, persistencePending: false };
      } catch (error) {
        return {
          ...result,
          persistencePending: true,
          message: `Saved ${path}; recovery persistence needs retry: ${String(error)}`,
        };
      }
    } catch (error) {
      // A still-identical source proves that this save did not replace it.
      let unchanged = false;
      try {
        unchanged = p.operationIdentity(path) === intent.identity;
      } catch {
        /* Retain uncertain intent. */
      }
      if (this.pending && !intent.completed && unchanged) await this.ack();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async ack(root?: string) {
    if (root && this.busy) throw Error("File operation still running.");
    if (root && this.handoff?.root === root) {
      // Renderer has reconciled its models/memory and awaited persistence before this request.
      await this.workspace.read();
      // An uncertain item must retain its journal even when earlier completed facts are delivered.
      if (!this.pending || this.pending.completed) {
        await this.journal.writeIntent(null);
        this.pending = undefined;
      }
      const remaining = (await this.journal.readFacts()).filter(fact => fact.root !== root);
      await this.journal.writeFacts(remaining);
      this.handoff = remaining.length ? { root: remaining[0].root, facts: remaining } : undefined;
      return;
    }
    if (root && this.pending && !this.pending.completed) throw Error("Uncertain operation retains its intent; restart to reconcile actual paths.");
    if (root && this.pending?.root !== root) throw Error("Operation belongs to another checkout.");
    await this.journal.writeIntent(null);
    this.pending = undefined;
  }
}
