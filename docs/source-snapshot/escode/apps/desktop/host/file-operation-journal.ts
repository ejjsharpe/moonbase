import type { DurableState } from "./durable-state";
import { isAbsolute } from "node:path";

export type Intent = {
  root: string;
  checkoutIdentity: string;
  source: string;
  destination: string;
  kind: "move" | "trash" | "save" | "copy";
  identity: string;
  completed?: boolean;
  preserveDrafts?: boolean;
  temporary?: string;
  copies?: import("./workspace").WorkspaceState["drafts"];
  saveText?: string;
  savedDisk?: import("./project").Document;
};

export class FileOperationJournal {
  private queue: Promise<unknown> = Promise.resolve();
  private revision?: number;
  constructor(_file: string, private owner: { hostId: string; clientId: string }, readonly database: DurableState) {}

  async readIntent(): Promise<Intent | null> {
    await this.queue;
    try {
      const stored = await this.database.recoveryRead(this.owner.clientId, "intent");
      this.revision = stored.revision;
      const v = stored.body as any;
      if (v === null) return null;
      validateIntent(v);
      return v;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async publishFact(fact: Intent) {
    await this.database.command("publishFileFact", { clientId: this.owner.clientId, body: fact });
    return this.readFacts();
  }
  private factsRevision?: number;
  async readFacts(): Promise<Intent[]> {
    const stored = await this.database.recoveryRead(this.owner.clientId, "fileFacts");
    this.factsRevision = stored.revision;
    if (stored.body === null) return [];
    if (!Array.isArray(stored.body)) throw Error("Invalid operation facts; retained for inspection.");
    for (const fact of stored.body) {
      validateIntent(fact);
      if (!fact.completed) throw Error("Incomplete operation fact; retained for inspection.");
    }
    return stored.body;
  }
  async writeFacts(facts: Intent[]) {
    if (this.factsRevision === undefined) await this.readFacts();
    await this.database.recoveryWrite(this.owner.clientId, "fileFacts", facts, this.factsRevision!);
    this.factsRevision!++;
  }
  writeIntent(intent: Intent | null) {
    return this.change(() => this.replace(intent));
  }
  private change(edit: () => Promise<void>) {
    const task = this.queue.then(edit);
    this.queue = task.catch(() => {});
    return task;
  }
  private async replace(value: unknown) {
    if (this.revision === undefined) this.revision = (await this.database.recoveryRead(this.owner.clientId, "intent")).revision;
    await this.database.recoveryWrite(this.owner.clientId, "intent", value, this.revision);
    this.revision++;
  }
}

function validateIntent(v: any): asserts v is Intent {
      if (
        !v ||
        !isAbsolute(v.root) ||
        !["move", "trash", "save", "copy"].includes(v.kind) ||
        typeof v.checkoutIdentity !== "string" ||
        typeof v.identity !== "string" ||
        typeof v.source !== "string" ||
        !v.source ||
        isAbsolute(v.source) ||
        v.source.split("/").some((p: string) => p === ".." || p.toLowerCase() === ".git") ||
        typeof v.destination !== "string" ||
        (["move", "copy"].includes(v.kind) &&
          (!v.destination ||
            isAbsolute(v.destination) ||
            v.destination
              .split("/")
              .some((p: string) => p === ".." || p.toLowerCase() === ".git"))) ||
        (v.kind === "copy" &&
          (!Array.isArray(v.copies) ||
            v.copies.some(
              (d: any) =>
                !d ||
                d.root !== v.root ||
                typeof d.path !== "string" ||
                isAbsolute(d.path) ||
                !(d.path === v.destination || d.path.startsWith(v.destination + "/")) ||
                d.path.split("/").some((p: string) => p === ".." || p.toLowerCase() === ".git") ||
                typeof d.text !== "string" ||
                typeof d.disk?.text !== "string" ||
                typeof d.disk?.version !== "string",
            ))) ||
        (v.preserveDrafts !== undefined && typeof v.preserveDrafts !== "boolean") ||
        (v.completed !== undefined && typeof v.completed !== "boolean") ||
        (v.kind === "save" &&
          (typeof v.saveText !== "string" ||
            (v.completed && !v.savedDisk) ||
            (v.savedDisk !== undefined &&
              (!v.savedDisk ||
                typeof v.savedDisk.text !== "string" ||
                typeof v.savedDisk.version !== "string"))))
      )
        throw Error("Invalid operation journal; retained for inspection.");
}
