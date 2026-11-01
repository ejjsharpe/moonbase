import {
  ApplicationError, emptyRecovery, maximumFileBytes,
  type CheckoutTarget, type CheckoutView, type Comparison, type DirectoryListing,
  type EditorClient, type EditorPosition, type EditorRecovery, type EntryReference,
  type FileDocument, type FileTarget, type FileView, type GitStatus,
  type OperationResult, type WorkspaceCommand, type CommandInput, type CommandOutput, type WorkspaceOperation,
} from "@moonbase/application/client";

export const checkoutKey = (target: CheckoutTarget) => JSON.stringify([
  target.hostId, target.checkoutId, target.projectId, target.root, target.branch,
]);
export const fileKey = (target: FileTarget) => JSON.stringify([checkoutKey(target.checkout), target.path]);
const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) => checkoutKey(a) === checkoutKey(b);
const affected = (path: string, parent: string) => path === parent || path.startsWith(parent + "/");
const validPath = (path: string, directory = false) => {
  if (directory && path === "") return;
  if (!path || path.length > 4096 || path.startsWith("/") || /[\\\0]/.test(path) ||
    path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))
    throw new ApplicationError({ code: "InvalidInput", message: "Use an exact relative path without traversal or .git." });
};
const view = (): CheckoutView => ({ openFiles: [], active: "", preview: null, fileViews: {}, positions: {},
  tree: { expanded: [], selected: [], focus: "", scroll: 0, hideIgnored: false } });

type PendingSave = CommandInput<"saveFile">;
export type EditorBuffer = {
  target: FileTarget; text: string; disk: FileDocument; conflict?: FileDocument;
  pendingSave?: PendingSave; saving: boolean;
};
export type CloseChoice = "save" | "discard" | "cancel";
export type ChooseClose = (file: Readonly<EditorBuffer>) => Promise<CloseChoice>;
export type EditorSnapshot = {
  ready: boolean; disposed: boolean; preserving: boolean; recovery: EditorRecovery;
  buffers: readonly EditorBuffer[]; comparisons: Readonly<Record<string, Comparison>>;
  listings: Readonly<Record<string, DirectoryListing>>; git: Readonly<Record<string, GitStatus>>;
  errors: readonly string[]; operations: readonly OperationResult[];
};
type ClosedAction = { checkout: CheckoutTarget; files: { path: string; index: number; view: FileView;
  positions?: CheckoutView["positions"][string] }[]; active: string };

/** One editor instance; IO always enters the application's injected command client. */
export class EditorController {
  readonly clientId: string;
  readonly instanceId = crypto.randomUUID();
  private client: EditorClient;
  private recovery: EditorRecovery;
  private revision = 0;
  private ready = false;
  private disposed = false;
  private preserving = false;
  private buffers = new Map<string, EditorBuffer>();
  private comparisons: Record<string, Comparison> = {};
  private listings: Record<string, DirectoryListing> = {};
  private git: Record<string, GitStatus> = {};
  private errors: string[] = [];
  private operations = new Map<string, { operation?: WorkspaceOperation; result: OperationResult; applied: Set<string> }>();
  private history: ClosedAction[] = [];
  private listeners = new Set<() => void>();
  private stops = new Map<string, () => void>();
  private requests = new Set<AbortController>();
  private activation = 0;
  private recoveryTail: Promise<unknown> = Promise.resolve();
  private scheduled?: ReturnType<typeof setTimeout>;
  private snapshot!: EditorSnapshot;
  constructor(options: { client: EditorClient; clientId?: string }) {
    this.client = options.client;
    this.clientId = options.clientId ?? crypto.randomUUID();
    if (!this.clientId.trim()) throw Error("An editor requires its own nonempty recovery client ID.");
    this.recovery = emptyRecovery(this.clientId);
    this.emit();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit() {
    this.snapshot = { ready: this.ready, disposed: this.disposed, preserving: this.preserving,
      recovery: structuredClone(this.recovery), buffers: structuredClone([...this.buffers.values()]),
      comparisons: { ...this.comparisons }, listings: { ...this.listings }, git: { ...this.git },
      errors: [...this.errors], operations: [...this.operations.values()].map(value => structuredClone(value.result)) };
    for (const listener of this.listeners) listener();
  }
  report = (error: unknown) => {
    if (this.disposed) return;
    this.errors = [...this.errors.slice(-19), error instanceof Error ? error.message : String(error)];
    this.emit();
  };
  clearErrors() { this.errors = []; this.emit(); }
  private assertReady() {
    if (this.disposed || !this.ready) throw Error(this.disposed ? "Editor disposed." : "Load editor recovery first.");
  }
  private checkout(target: CheckoutTarget) {
    this.assertReady();
    if (!this.recovery.checkouts.some(item => sameCheckout(item, target)))
      throw Error("This exact checkout is not open in this editor.");
    return this.recovery.views[checkoutKey(target)] ??= view();
  }
  private async command<K extends WorkspaceCommand>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
    if (this.disposed) throw Error("Editor disposed.");
    const abort = new AbortController();
    this.requests.add(abort);
    try { return await this.client.command(name, input, { signal: abort.signal }); }
    catch (error) { this.report(error); throw error; }
    finally { this.requests.delete(abort); }
  }
  async load() {
    if (this.ready) return;
    const loaded = await this.command("loadRecovery", { clientId: this.clientId });
    if (this.disposed) return;
    if (loaded.state.clientId !== this.clientId) throw Error("Recovery belongs to another editor client.");
    this.recovery = structuredClone(loaded.state);
    this.revision = loaded.revision;
    this.errors.push(...loaded.errors);
    for (const draft of this.recovery.drafts) {
      this.buffers.set(fileKey(draft.target), { ...structuredClone(draft), saving: false });
      const selected = this.recovery.views[checkoutKey(draft.target.checkout)] ??= view();
      if (!selected.openFiles.includes(draft.target.path)) selected.openFiles.push(draft.target.path);
      if (selected.preview === draft.target.path) selected.preview = null;
    }
    for (const result of loaded.operations) this.operations.set(result.id, { result, applied: new Set() });
    this.ready = true;
    for (const result of loaded.operations) {
      try { await this.reconcileOperation(undefined, result); }
      catch (error) { this.report(error); }
    }
    for (const checkout of this.recovery.checkouts) this.observe(checkout);
    this.emit();
  }
  private observe(checkout: CheckoutTarget) {
    const key = checkoutKey(checkout);
    this.stops.get(key)?.();
    this.stops.set(key, this.client.watch({ checkout, paths: [""] }, event => {
      if (this.disposed || !sameCheckout(event.checkout, checkout)) return;
      if (event.error) this.report(event.error);
      if (event.ready) return;
      void this.refresh(checkout).catch(this.report);
    }, this.report));
  }
  async openCheckout(root: string) {
    this.assertReady();
    const target = await this.command("openCheckout", { root });
    if (this.disposed) return target;
    const collision = this.recovery.checkouts.find(item => item.checkoutId === target.checkoutId && !sameCheckout(item, target));
    if (collision) throw Error("Checkout identity changed; retained work has not been rebound.");
    if (!this.recovery.checkouts.some(item => sameCheckout(item, target))) {
      this.recovery.checkouts.push(target);
      this.recovery.views[checkoutKey(target)] = view();
      this.observe(target);
    }
    this.selectCheckout(target);
    await this.refresh(target);
    return target;
  }
  selectCheckout(target: CheckoutTarget) {
    this.checkout(target);
    this.recovery.selectedCheckoutId = target.checkoutId;
    this.changed();
  }
  private changed() { this.emit(); this.schedule(); }
  private schedule() {
    if (!this.ready || this.disposed || this.preserving) return;
    clearTimeout(this.scheduled);
    this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.flush().catch(this.report); }, 150);
  }
  private capture(): EditorRecovery {
    const state = structuredClone(this.recovery);
    state.drafts = [...this.buffers.values()].filter(buffer => buffer.text !== buffer.disk.text || buffer.pendingSave)
      .map(({ target, text, disk }) => structuredClone({ target, text, disk }));
    return state;
  }
  private publish(state: EditorRecovery) {
    const captured = structuredClone(state);
    const next = this.recoveryTail.catch(() => {}).then(async () => {
      const result = await this.command("persistRecovery", { clientId: this.clientId,
        expectedRevision: this.revision, state: captured });
      this.revision = result.revision;
    });
    this.recoveryTail = next;
    return next;
  }
  async flush() {
    this.assertReady();
    clearTimeout(this.scheduled); this.scheduled = undefined;
    await this.publish(this.capture());
  }
  buffer(target: FileTarget): Readonly<EditorBuffer> | undefined {
    return this.snapshot.buffers.find(buffer => fileKey(buffer.target) === fileKey(target));
  }
  edit(target: FileTarget, text: string) {
    this.checkout(target.checkout); validPath(target.path);
    if (this.preserving) throw Error("Finish the captured preservation action first.");
    if (new TextEncoder().encode(text).length > maximumFileBytes) throw Error("Editable text exceeds 2 MiB.");
    const buffer = this.buffers.get(fileKey(target));
    if (!buffer) throw Error("Open this file before editing it.");
    buffer.text = text;
    if (text !== buffer.disk.text) this.keepOpen(target);
    this.changed();
  }
  keepOpen(target: FileTarget) {
    const selected = this.checkout(target.checkout);
    if (selected.preview === target.path) { selected.preview = null; this.changed(); }
  }
  async open(target: FileTarget, options: { view?: FileView; intent?: "preview" | "keep"; current?: () => boolean } = {}) {
    const selected = this.checkout(target.checkout); validPath(target.path);
    if (this.preserving) return false;
    const generation = ++this.activation;
    const current = () => !this.disposed && generation === this.activation && (options.current?.() ?? true) &&
      this.recovery.checkouts.some(item => sameCheckout(item, target.checkout));
    const key = fileKey(target), mode = options.view ?? selected.fileViews[target.path] ?? "file";
    try {
      let disk: FileDocument | null, comparison: Comparison | undefined;
      if (mode === "file" || mode === "conflict") disk = await this.command("readFile", target);
      else {
        comparison = await this.command("readComparison", { target, area: mode });
        disk = comparison.working;
      }
      if (!current()) return false;
      let buffer = this.buffers.get(key);
      if (!buffer && disk) { buffer = { target, text: disk.text, disk, saving: false }; this.buffers.set(key, buffer); }
      else if (buffer && disk && buffer.text === buffer.disk.text && !buffer.pendingSave) {
        buffer.disk = disk; buffer.text = disk.text;
      }
      if (buffer && disk && buffer.disk.version !== disk.version) buffer.conflict = disk;
      if (mode === "conflict") comparison = { original: disk!.text, working: disk, title: "Disk versus your edits" };
      if (comparison) this.comparisons[key] = comparison;
      else delete this.comparisons[key];
      if (comparison?.error) this.report(comparison.error);
      if (!selected.openFiles.includes(target.path)) {
        const previous = selected.preview;
        if (options.intent === "preview" && previous && previous !== target.path) {
          const oldKey = fileKey({ checkout: target.checkout, path: previous }), old = this.buffers.get(oldKey);
          if (!old || old.text === old.disk.text && !old.pendingSave) {
            selected.openFiles = selected.openFiles.filter(path => path !== previous);
            this.buffers.delete(oldKey); delete this.comparisons[oldKey];
          }
        }
        selected.openFiles.splice(selected.openFiles.indexOf(selected.active) + 1, 0, target.path);
        if (options.intent === "preview" && (!buffer || buffer.text === buffer.disk.text)) selected.preview = target.path;
      }
      if (options.intent === "keep") selected.preview = selected.preview === target.path ? null : selected.preview;
      selected.active = target.path; selected.fileViews[target.path] = mode;
      this.recovery.selectedCheckoutId = target.checkout.checkoutId;
      this.recovery.recentFiles = [target, ...this.recovery.recentFiles.filter(item => fileKey(item) !== key)].slice(0, 100);
      this.changed();
      return true;
    } catch { return false; }
  }
  async save(target: FileTarget, overwrite = false): Promise<boolean> {
    this.checkout(target.checkout);
    const buffer = this.buffers.get(fileKey(target));
    if (!buffer || buffer.saving) return false;
    const request = buffer.pendingSave ?? { target: structuredClone(target), clientId: this.clientId,
      requestId: crypto.randomUUID(), text: buffer.text, expectedVersion: overwrite && buffer.conflict ? buffer.conflict.version : buffer.disk.version };
    buffer.pendingSave = request; buffer.saving = true; this.emit();
    try {
      const result = await this.command("saveFile", request);
      if (this.disposed) return false;
      if (result.kind === "conflict") {
        buffer.pendingSave = undefined; buffer.conflict = result.disk;
        this.report("Disk changed. Your edits are retained. Compare, overwrite this version, reload or cancel.");
        return false;
      }
      if (result.persistencePending) {
        this.report(result.message ?? "Saved on disk; recovery is uncertain. Edits retained. Retry the same Save before closing.");
        return false;
      }
      buffer.disk = result.disk; buffer.pendingSave = undefined; buffer.conflict = undefined;
      await this.flush();
      return buffer.text === result.disk.text;
    } finally { buffer.saving = false; this.emit(); }
  }
  async reload(target: FileTarget) {
    this.checkout(target.checkout);
    const buffer = this.buffers.get(fileKey(target));
    if (!buffer || buffer.pendingSave || this.preserving) return false;
    this.preserving = true; this.emit();
    try {
      const disk = await this.command("readFile", target);
      const state = this.capture(); state.drafts = state.drafts.filter(item => fileKey(item.target) !== fileKey(target));
      await this.publish(state);
      buffer.disk = disk; buffer.text = disk.text; buffer.conflict = undefined;
      if (this.checkout(target.checkout).fileViews[target.path] === "conflict")
        this.comparisons[fileKey(target)] = { original: disk.text, working: disk, title: "Disk versus your edits" };
      return true;
    } finally { this.preserving = false; this.emit(); }
  }
  cancelConflict(target: FileTarget) {
    const buffer = this.buffers.get(fileKey(target));
    if (buffer) buffer.conflict = undefined;
    const selected = this.checkout(target.checkout);
    if (selected.fileViews[target.path] === "conflict") selected.fileViews[target.path] = "file";
    this.changed();
  }
  position(target: FileTarget, mode: FileView | `${FileView}:original`, position: EditorPosition) {
    if (this.disposed || this.preserving) return;
    const selected = this.checkout(target.checkout);
    if (!selected.openFiles.includes(target.path)) return;
    (selected.positions[target.path] ??= {})[mode] = position;
    this.changed();
  }
  reorder(checkout: CheckoutTarget, from: string, to: number) {
    const selected = this.checkout(checkout);
    if (this.preserving || !selected.openFiles.includes(from)) return;
    selected.openFiles.splice(selected.openFiles.indexOf(from), 1);
    selected.openFiles.splice(Math.max(0, Math.min(to, selected.openFiles.length)), 0, from);
    this.keepOpen({ checkout, path: from }); this.changed();
  }
  navigate(checkout: CheckoutTarget, direction: 1 | -1, order: "visual" | "recent" = "visual") {
    const selected = this.checkout(checkout);
    const paths = order === "visual" ? selected.openFiles : [...new Set([
      ...this.recovery.recentFiles.filter(item => sameCheckout(item.checkout, checkout)).map(item => item.path), ...selected.openFiles,
    ])].filter(path => selected.openFiles.includes(path));
    if (!paths.length) return Promise.resolve(false);
    const next = (paths.indexOf(selected.active) + direction + paths.length) % paths.length;
    return this.open({ checkout, path: paths[next] });
  }
  async close(targets: FileTarget[], choose: ChooseClose) { return this.preserve(targets, choose, "files"); }
  async closeCheckout(checkout: CheckoutTarget, choose: ChooseClose) {
    const selected = this.checkout(checkout);
    return this.preserve(selected.openFiles.map(path => ({ checkout, path })), choose, "checkout", checkout);
  }
  async prepareQuit(choose: ChooseClose) {
    return this.preserve([...this.buffers.values()].map(buffer => buffer.target), choose, "quit");
  }
  private async preserve(targets: FileTarget[], choose: ChooseClose, kind: "files" | "checkout" | "quit", checkout?: CheckoutTarget) {
    this.assertReady();
    if (this.preserving || [...this.buffers.values()].some(buffer => buffer.saving || buffer.pendingSave)) return false;
    const captured = [...new Map(targets.map(target => [fileKey(target), structuredClone(target)])).values()];
    this.preserving = true; this.activation++; clearTimeout(this.scheduled); this.emit();
    const discarded = new Set<string>();
    try {
      for (const target of captured) {
        const buffer = this.buffers.get(fileKey(target));
        if (!buffer || buffer.text === buffer.disk.text) continue;
        const choice = await choose(structuredClone(buffer));
        if (choice === "cancel") return false;
        if (choice === "discard") discarded.add(fileKey(target));
        else if (!await this.save(target)) return false;
      }
      const state = this.capture();
      const keys = new Set(captured.map(fileKey));
      state.drafts = state.drafts.filter(draft => !discarded.has(fileKey(draft.target)) && (kind === "quit" || !keys.has(fileKey(draft.target))));
      const history: ClosedAction[] = [];
      if (kind !== "quit") for (const target of state.checkouts) {
        const selected = state.views[checkoutKey(target)];
        const closing = selected.openFiles.filter(path => keys.has(fileKey({ checkout: target, path })));
        if (!closing.length) continue;
        history.push({ checkout: target, active: closing.includes(selected.active) ? selected.active : closing.at(-1)!,
          files: closing.map(path => ({ path, index: selected.openFiles.indexOf(path), view: selected.fileViews[path] ?? "file",
            positions: structuredClone(selected.positions[path]) })) });
        selected.openFiles = selected.openFiles.filter(path => !closing.includes(path));
        if (closing.includes(selected.active)) selected.active = this.recovery.recentFiles.find(item =>
          sameCheckout(item.checkout, target) && selected.openFiles.includes(item.path))?.path ?? selected.openFiles[0] ?? "";
        if (selected.preview && closing.includes(selected.preview)) selected.preview = null;
      }
      if (kind === "checkout" && checkout) {
        state.checkouts = state.checkouts.filter(item => !sameCheckout(item, checkout)); delete state.views[checkoutKey(checkout)];
        if (state.selectedCheckoutId === checkout.checkoutId) state.selectedCheckoutId = state.checkouts[0]?.checkoutId ?? null;
      }
      await this.publish(state);
      this.recovery = state;
      if (kind === "quit") for (const key of discarded) {
        const buffer = this.buffers.get(key)!; buffer.text = buffer.disk.text; buffer.conflict = undefined;
      }
      else {
        this.history = [...this.history, ...history].slice(-20);
        for (const key of keys) { this.buffers.delete(key); delete this.comparisons[key]; }
        if (kind === "checkout" && checkout) { this.stops.get(checkoutKey(checkout))?.(); this.stops.delete(checkoutKey(checkout)); }
      }
      return true;
    } catch (error) { this.report(error); return false; }
    finally { this.preserving = false; this.emit(); }
  }
  async reopen(checkout: CheckoutTarget) {
    const selected = this.checkout(checkout);
    if (this.preserving) return false;
    const index = this.history.findLastIndex(action => sameCheckout(action.checkout, checkout));
    if (index < 0) return false;
    const action = this.history[index];
    for (const file of action.files) if (!selected.openFiles.includes(file.path)) {
      selected.openFiles.splice(Math.min(file.index, selected.openFiles.length), 0, file.path);
      selected.fileViews[file.path] = file.view;
      if (file.positions) selected.positions[file.path] = structuredClone(file.positions);
    }
    selected.active = action.active; selected.preview = null;
    const success = await this.open({ checkout, path: action.active });
    await this.flush(); this.history.splice(index, 1); this.emit();
    return success;
  }
  tree(checkout: CheckoutTarget, patch: Partial<CheckoutView["tree"]>) {
    const selected = this.checkout(checkout); selected.tree = { ...selected.tree, ...patch }; this.changed();
  }
  resizeSidebar(width: number) {
    this.recovery.sidebarWidth = Math.max(190, Math.min(380, Math.round(width))); this.changed();
  }
  async list(checkout: CheckoutTarget, path = "") {
    const selected = this.checkout(checkout); validPath(path, true);
    const listing = await this.command("listDirectory", { checkout, path, hideIgnored: selected.tree.hideIgnored });
    if (this.disposed) return listing;
    this.listings[JSON.stringify([checkoutKey(checkout), path])] = listing; this.emit();
    return listing;
  }
  async reveal(target: FileTarget, showIgnored = false) {
    const selected = this.checkout(target.checkout); validPath(target.path);
    const parts = target.path.split("/"), expanded: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join("/");
      const listing = await this.command("listDirectory", { checkout: target.checkout, path: parts.slice(0, i).join("/"), hideIgnored: false });
      const entry = listing.entries.find(item => item.path === path);
      if (!entry) throw Error(listing.error ?? "Active file unavailable. Refresh and retry.");
      if (entry.ignored && selected.tree.hideIgnored && !showIgnored) throw Error("Active file is hidden. Turn off Hide Git-ignored files and reveal again.");
      if (i < parts.length - 1) expanded.push(path);
    }
    this.tree(target.checkout, { expanded: [...new Set([...selected.tree.expanded, ...expanded])],
      focus: target.path, selected: [target.path], ...(showIgnored ? { hideIgnored: false } : {}) });
    await Promise.all(["", ...expanded].map(path => this.list(target.checkout, path)));
  }
  async lookup(checkout: CheckoutTarget, query: string) {
    this.checkout(checkout);
    return this.command("lookupFiles", { checkout, query, limit: 100 });
  }
  async refresh(checkout: CheckoutTarget) {
    this.checkout(checkout);
    const paths = ["", ...this.checkout(checkout).tree.expanded];
    await Promise.allSettled(paths.map(path => this.list(checkout, path)));
    try { this.git[checkoutKey(checkout)] = await this.command("gitStatus", { checkout }); }
    catch { /* The public command already reported the error; retained buffers stay usable. */ }
    if (!this.disposed) this.emit();
  }
  async inspect(checkout: CheckoutTarget, paths: string[]) {
    this.checkout(checkout); paths.forEach(path => validPath(path));
    return this.command("inspectEntries", { checkout, paths });
  }
  async mutate(input: Omit<WorkspaceOperation, "clientId" | "id"> & { id?: string }) {
    this.checkout(input.checkout);
    if (this.preserving) throw Error("Finish the captured preservation action first.");
    const operation: WorkspaceOperation = { ...structuredClone(input), clientId: this.clientId, id: input.id ?? crypto.randomUUID() };
    if (this.operations.has(operation.id)) throw Error("Operation already submitted. Resolve its status instead of dispatching it again.");
    if (operation.destination !== undefined) validPath(operation.destination);
    for (const source of [...operation.sources, ...(operation.replacements ?? [])]) {
      validPath(source.target.path);
      if (!sameCheckout(source.target.checkout, operation.checkout)) throw Error("A file operation must use one exact checkout.");
    }
    const replacementPaths = [...(operation.replacements ?? []).map(item => item.target.path), ...(operation.destination ? [operation.destination] : [])];
    if ([...this.buffers.values()].some(buffer => sameCheckout(buffer.target.checkout, operation.checkout) &&
      !operation.sources.some(source => affected(buffer.target.path, source.target.path)) &&
      replacementPaths.some(path => affected(buffer.target.path.normalize("NFC").toLowerCase(), path.normalize("NFC").toLowerCase()))))
      throw Error("Replacement has open buffers. Close them safely before replacing their files.");
    if ([...this.buffers.values()].some(buffer => sameCheckout(buffer.target.checkout, operation.checkout) &&
      operation.sources.some(source => affected(buffer.target.path, source.target.path)) && (buffer.saving || buffer.pendingSave)))
      throw Error("Resolve the source Save before moving or copying it.");
    // Publish dirty source drafts before any external mutation, including Trash.
    await this.flush();
    const uncertain: OperationResult = { id: operation.id, checkout: operation.checkout, kind: operation.kind, outcome: "uncertain", items: [], message: "Awaiting operation status." };
    this.operations.set(operation.id, { operation, result: uncertain, applied: new Set() }); this.emit();
    try {
      const result = await this.command("mutate", operation);
      return await this.reconcileOperation(operation, result);
    } catch (error) { this.report("Operation outcome unconfirmed. Resolve status before taking further action."); throw error; }
  }
  async resolveOperation(id: string) {
    const known = this.operations.get(id);
    if (!known) throw Error("Unknown operation.");
    const result = await this.command("operationStatus", { clientId: this.clientId, id });
    if (!result) { this.report("Operation status unavailable; drafts and original references retained."); return null; }
    return this.reconcileOperation(known.operation, result);
  }
  private async reconcileOperation(operation: WorkspaceOperation | undefined, result: OperationResult) {
    const known = this.operations.get(result.id);
    if (!known || operation && (result.id !== operation.id || result.kind !== operation.kind || !sameCheckout(result.checkout, operation.checkout)) ||
      !sameCheckout(known.result.checkout, result.checkout) || !this.recovery.checkouts.some(item => sameCheckout(item, result.checkout)))
      throw Error("Operation checkout identity unavailable or changed. Evidence and drafts retained without rebinding.");
    known.result = result;
    for (const item of result.items.filter(item => item.outcome === "completed")) {
      const itemKey = JSON.stringify([item.source, item.destination]);
      if (known.applied.has(itemKey)) continue;
      if (operation && !operation.sources.some(source => source.target.path === item.source)) continue;
      if (result.kind === "move" && item.destination) this.moveReferences(result.checkout, item.source, item.destination);
      if (result.kind === "copy" && item.destination) {
        for (const buffer of [...this.buffers.values()]) if (sameCheckout(buffer.target.checkout, result.checkout) && affected(buffer.target.path, item.source) && buffer.text !== buffer.disk.text) {
          const target = { checkout: result.checkout, path: item.destination + buffer.target.path.slice(item.source.length) };
          if (!this.buffers.has(fileKey(target))) {
            const disk = await this.command("readFile", target);
            this.buffers.set(fileKey(target), { target, disk, text: buffer.text, saving: false });
            const selected = this.checkout(result.checkout);
            if (!selected.openFiles.includes(target.path)) selected.openFiles.push(target.path);
          }
        }
      }
      // Trash keeps dirty drafts visible at their original target for manual recovery.
      if (result.kind === "trash") this.history = this.history.flatMap(action => {
        if (!sameCheckout(action.checkout, result.checkout)) return [action];
        action.files = action.files.filter(file => !affected(file.path, item.source));
        return action.files.length ? [action] : [];
      });
      known.applied.add(itemKey);
    }
    await this.flush();
    if (result.outcome !== "uncertain") await this.command("acknowledgeOperation", { clientId: this.clientId, id: result.id });
    this.emit(); await this.refresh(result.checkout);
    return result;
  }
  private moveReferences(checkout: CheckoutTarget, source: string, destination: string) {
    const move = (path: string) => affected(path, source) ? destination + path.slice(source.length) : path;
    const selected = this.checkout(checkout);
    for (const [key, buffer] of [...this.buffers]) if (sameCheckout(buffer.target.checkout, checkout) && affected(buffer.target.path, source)) {
      this.buffers.delete(key); buffer.target = { checkout, path: move(buffer.target.path) }; this.buffers.set(fileKey(buffer.target), buffer);
      if (this.comparisons[key]) { this.comparisons[fileKey(buffer.target)] = this.comparisons[key]; delete this.comparisons[key]; }
    }
    selected.openFiles = selected.openFiles.map(move); selected.active = move(selected.active);
    if (selected.preview) selected.preview = move(selected.preview);
    selected.fileViews = Object.fromEntries(Object.entries(selected.fileViews).map(([path, mode]) => [move(path), mode]));
    selected.positions = Object.fromEntries(Object.entries(selected.positions).map(([path, positions]) => [move(path), positions]));
    selected.tree.expanded = selected.tree.expanded.map(move); selected.tree.selected = selected.tree.selected.map(move); selected.tree.focus = move(selected.tree.focus);
    this.recovery.recentFiles = this.recovery.recentFiles.map(item => sameCheckout(item.checkout, checkout) ? { checkout, path: move(item.path) } : item);
    for (const action of this.history) if (sameCheckout(action.checkout, checkout)) {
      action.active = move(action.active); action.files = action.files.map(file => ({ ...file, path: move(file.path) }));
    }
  }
  /** Release resources after a successful close/Quit gate. Hiding a view must not call this. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.activation++; clearTimeout(this.scheduled);
    for (const stop of this.stops.values()) stop(); this.stops.clear();
    for (const abort of this.requests) abort.abort(); this.requests.clear();
    this.emit(); this.listeners.clear();
  }
}

export const createEditor = (options: ConstructorParameters<typeof EditorController>[0]) => new EditorController(options);
