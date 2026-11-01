import { Effect, Layer, Queue, Stream } from "effect";
import { WorkspaceService, type WorkspaceServiceShape } from "@moonbase/application/services";
import { ApplicationError, emptyRecovery, maximumFileBytes, type CheckoutTarget, type FileDocument,
  type FileTarget, type WorkspaceCommand, type EditorRecovery, type OperationResult, type SaveResult, type WorkspaceEvent,
} from "@moonbase/application/client";
import { checkoutKey, fileKey } from "./editor.ts";

type Seed = { checkout: CheckoutTarget; files: Record<string, string>; head?: Record<string, string>; index?: Record<string, string>; ignored?: string[] };
type Entry = FileDocument & { directory: boolean };
const fail = (message: string, code: ApplicationError["code"] = "InvalidInput"): never => { throw new ApplicationError({ code, message }); };
const pathCheck = (path: string, directory = false) => {
  if (directory && path === "") return;
  if (!path || path.startsWith("/") || /[\\\0]/.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) fail("Invalid relative path.");
};
const affected = (path: string, source: string) => path === source || path.startsWith(source + "/");

/** Concrete volatile adapter for demos/tests. It makes no filesystem or durability claim. */
export function memoryWorkspace(seeds: Seed[]) {
  let version = 0;
  const files = new Map<string, Map<string, Entry>>();
  const recoveries = new Map<string, { revision: number; state: EditorRecovery }>();
  const saves = new Map<string, { payload: string; result: SaveResult }>();
  const operations = new Map<string, { payload: string; result: OperationResult; clientId: string; ack: boolean }>();
  const watchers = new Set<{ checkout: CheckoutTarget; notify: (event: WorkspaceEvent) => void }>();
  const faults = new Map<WorkspaceCommand, { error: ApplicationError; after: boolean }>();
  const stats = { subscriptions: 0, released: 0, active: 0, mutations: 0, saves: 0, publications: 0 };
  const document = (text: string): FileDocument => {
    if (new TextEncoder().encode(text).length > maximumFileBytes || text.includes("\0")) fail("Only UTF-8 text up to 2 MiB is editable.");
    return { text, version: String(++version) };
  };
  const exact = (checkout: CheckoutTarget) => {
    const seed = seeds.find(seed => checkoutKey(seed.checkout) === checkoutKey(checkout));
    if (!seed) fail("Exact checkout unavailable.", "Unavailable");
    return seed!;
  };
  const entries = (checkout: CheckoutTarget) => { exact(checkout); return files.get(checkoutKey(checkout))!; };
  const read = (target: FileTarget) => {
    pathCheck(target.path); const entry = entries(target.checkout).get(target.path);
    if (!entry || entry.directory) return fail("File unavailable.", "Unavailable");
    return { text: entry.text, version: entry.version };
  };
  const notify = (checkout: CheckoutTarget, paths: string[]) => {
    for (const watcher of watchers) if (checkoutKey(watcher.checkout) === checkoutKey(checkout)) watcher.notify({ checkout, paths });
  };
  for (const seed of seeds) {
    const map = new Map<string, Entry>(); files.set(checkoutKey(seed.checkout), map);
    for (const [path, text] of Object.entries(seed.files)) {
      pathCheck(path); map.set(path, { ...document(text), directory: false });
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) map.set(parts.slice(0, i).join("/"), { text: "", version: String(++version), directory: true });
    }
  }
  const call = <A>(name: WorkspaceCommand, action: () => A) => Effect.try({
    try: () => {
      const fault = faults.get(name); faults.delete(name);
      if (fault && !fault.after) throw fault.error;
      const value = action();
      if (fault) throw fault.error;
      return structuredClone(value);
    }, catch: error => error instanceof ApplicationError ? error : new ApplicationError({ code: "Unavailable", message: String(error) }),
  });
  const service: WorkspaceServiceShape = {
    openCheckout: ({ root }) => call("openCheckout", () => seeds.find(seed => seed.checkout.root === root)?.checkout ?? fail("Checkout unavailable.", "Unavailable")),
    readFile: target => call("readFile", () => read(target)),
    saveFile: input => call("saveFile", () => {
      if (!input.clientId || !input.requestId) fail("Save requires immutable request and client IDs.");
      const key = JSON.stringify([input.clientId, input.requestId]), payload = JSON.stringify(input), previous = saves.get(key);
      if (previous) return previous.payload === payload ? previous.result : fail("Save ID reused with changed payload.", "Conflict");
      const disk = read(input.target);
      const result: SaveResult = disk.version !== input.expectedVersion ? { kind: "conflict", disk } : { kind: "saved", disk: document(input.text) };
      saves.set(key, { payload, result });
      if (result.kind === "saved") {
        entries(input.target.checkout).set(input.target.path, { ...result.disk, directory: false }); stats.saves++;
        notify(input.target.checkout, [input.target.path]);
      }
      return result;
    }),
    listDirectory: ({ checkout, path, hideIgnored }) => call("listDirectory", () => {
      pathCheck(path, true); const seed = exact(checkout), prefix = path ? path + "/" : "";
      if (path && !entries(checkout).get(path)?.directory) fail("Directory unavailable.", "Unavailable");
      const values = [...entries(checkout)].filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
        .map(([name, entry]) => ({ path: name, directory: entry.directory, ignored: seed.ignored?.some(item => affected(name, item)) ?? false }));
      return { entries: values.filter(entry => !hideIgnored || !entry.ignored).sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path)), partial: false };
    }),
    gitStatus: ({ checkout }) => call("gitStatus", () => {
      const seed = exact(checkout), changes: { path: string; area: "staged" | "unstaged" | "untracked" }[] = [];
      for (const [path, entry] of entries(checkout)) if (!entry.directory) {
        const index = seed.index?.[path] ?? seed.head?.[path];
        if (index === undefined) changes.push({ path, area: "untracked" });
        else if (entry.text !== index) changes.push({ path, area: "unstaged" });
        if (seed.index?.[path] !== undefined && seed.index[path] !== seed.head?.[path]) changes.push({ path, area: "staged" });
      }
      return { branch: checkout.branch, changes };
    }),
    readComparison: ({ target, area }) => call("readComparison", () => {
      const seed = exact(target.checkout); pathCheck(target.path);
      const original = area === "untracked" ? "" : area === "staged" ? seed.head?.[target.path] : seed.index?.[target.path] ?? seed.head?.[target.path];
      if (original === undefined) fail("Git baseline unavailable.", "Unavailable");
      const working = entries(target.checkout).get(target.path);
      return { original: original!, working: working && !working.directory ? read(target) : null, title: `${area} · ${target.path}` };
    }),
    lookupFiles: ({ checkout, query, limit = 100 }) => call("lookupFiles", () => {
      const seed = exact(checkout);
      // Independent substring lookup; the excluded Microsoft scorer is never used.
      const matches = [...entries(checkout)].filter(([path, entry]) => !entry.directory && path.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && !seed.ignored?.some(item => affected(path, item))).map(([path]) => path).sort();
      return { paths: matches.slice(0, Math.max(1, Math.min(limit, 100))), partial: matches.length > limit };
    }),
    inspectEntries: ({ checkout, paths }) => call("inspectEntries", () => paths.map(path => {
      pathCheck(path); const entry = entries(checkout).get(path) ?? fail("Entry unavailable.", "Unavailable");
      return { target: { checkout, path }, identity: entry.version, directory: entry.directory };
    })),
    mutate: operation => call("mutate", () => {
      const key = JSON.stringify([operation.clientId, operation.id]), payload = JSON.stringify(operation), previous = operations.get(key);
      if (previous) return previous.payload === payload ? previous.result : fail("Operation ID reused with changed payload.", "Conflict");
      if (!operation.id || !operation.clientId) fail("Operation requires immutable IDs.");
      const map = entries(operation.checkout);
      const result: OperationResult = { id: operation.id, kind: operation.kind, outcome: "completed", items: [] };
      for (const ref of [...operation.sources, ...(operation.replacements ?? [])]) {
        pathCheck(ref.target.path);
        if (checkoutKey(ref.target.checkout) !== checkoutKey(operation.checkout) || map.get(ref.target.path)?.version !== ref.identity) fail("Entry identity changed.", "Conflict");
      }
      if (operation.kind === "import") fail("Memory adapter has no native file authority.", "Unavailable");
      if (operation.destination) pathCheck(operation.destination);
      const replace = (destination: string) => {
        const collision = [...map.keys()].find(path => path.normalize("NFC").toLowerCase() === destination.normalize("NFC").toLowerCase());
        if (collision && !operation.replacements?.some(ref => ref.target.path === collision)) fail("Destination exists. Explicit replacement consent required.", "Conflict");
        if (collision) for (const path of [...map.keys()]) if (affected(path, collision)) map.delete(path);
        const parent = destination.split("/").slice(0, -1).join("/");
        if (parent && !map.get(parent)?.directory) fail("Destination parent unavailable.", "Unavailable");
      };
      if (operation.kind === "create-file" || operation.kind === "create-directory") {
        const destination = operation.destination ?? fail("Destination required."); replace(destination);
        map.set(destination, { ...document(operation.text ?? ""), directory: operation.kind === "create-directory" });
        result.items.push({ source: "", destination, outcome: "completed" });
      } else for (const source of operation.sources) {
        const destination = operation.destination;
        if (operation.kind !== "trash" && !destination) fail("Destination required.");
        if (destination && affected(destination, source.target.path)) fail("Cannot transfer an entry into itself.");
        if (destination) replace(destination);
        const selected = [...map].filter(([path]) => affected(path, source.target.path));
        for (const [path, entry] of selected) {
          if (destination) map.set(destination + path.slice(source.target.path.length), { ...entry, version: String(++version) });
          if (operation.kind !== "copy") map.delete(path);
        }
        result.items.push({ source: source.target.path, ...(destination ? { destination } : {}), outcome: "completed" });
      }
      operations.set(key, { payload, result, clientId: operation.clientId, ack: false }); stats.mutations++;
      notify(operation.checkout, result.items.map(item => item.destination ?? item.source));
      return result;
    }),
    operationStatus: ({ clientId, id }) => call("operationStatus", () => operations.get(JSON.stringify([clientId, id]))?.result ?? null),
    acknowledgeOperation: ({ clientId, id }) => call("acknowledgeOperation", () => {
      const entry = operations.get(JSON.stringify([clientId, id])); if (!entry) fail("Unknown operation."); entry!.ack = true;
    }),
    loadRecovery: ({ clientId }) => call("loadRecovery", () => ({ ...(recoveries.get(clientId) ?? { revision: 0, state: emptyRecovery(clientId) }), errors: [],
      operations: [...operations.values()].filter(item => item.clientId === clientId && !item.ack).map(item => item.result) })),
    persistRecovery: ({ clientId, expectedRevision, state }) => call("persistRecovery", () => {
      if (!clientId || state.clientId !== clientId || state.version !== 1) fail("Recovery client mismatch.");
      if ((recoveries.get(clientId)?.revision ?? 0) !== expectedRevision) fail("Recovery revision changed.", "Conflict");
      for (const draft of state.drafts) { exact(draft.target.checkout); pathCheck(draft.target.path); if (new TextEncoder().encode(draft.text).length > maximumFileBytes) fail("Draft too large."); }
      const revision = expectedRevision + 1; recoveries.set(clientId, { revision, state: structuredClone(state) }); stats.publications++;
      return { revision };
    }),
    watch: ({ checkout }) => Stream.callback(queue => Effect.acquireRelease(Effect.sync(() => {
      exact(checkout); const watcher = { checkout, notify: (event: WorkspaceEvent) => { Queue.offerUnsafe(queue, event); } };
      watchers.add(watcher); stats.subscriptions++; stats.active++;
      watcher.notify({ checkout, paths: [], ready: true });
      return watcher;
    }), watcher => Effect.sync(() => { watchers.delete(watcher); stats.released++; stats.active--; })), { bufferSize: 1 }),
  };
  return {
    layer: Layer.succeed(WorkspaceService, service), stats,
    externalWrite(target: FileTarget, text: string) { read(target); entries(target.checkout).set(target.path, { ...document(text), directory: false }); notify(target.checkout, [target.path]); },
    failNext(name: WorkspaceCommand, message = "Injected IO failure", after = false) { faults.set(name, { error: new ApplicationError({ code: after ? "Uncertain" : "Persistence", message }), after }); },
  };
}
