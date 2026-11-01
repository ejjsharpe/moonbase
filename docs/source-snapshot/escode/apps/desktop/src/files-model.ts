export type Entry = { path: string; directory: boolean };
export type Listing = { entries?: Entry[]; error?: string; ignored?: string[]; filterError?: string; slow?: boolean };
export type FileRow = Entry & { level: number; position: number; size: number; parent: string };
export type FilesSource = {
  list(path: string, signal: AbortSignal): Promise<Listing>;
  watch(paths: string[], changed: (error?: string, ready?: boolean) => void): () => void;
};

/** Exact paths identify nodes; cancellation is logical even when the adapter cannot abort I/O. */
export class FilesModel {
  cache: Record<string, Listing> = Object.create(null);
  private nodes = new Map<string, Entry>();
  private pending = new Map<string, { controller: AbortController; promise: Promise<Listing> }>();
  private listeners = new Set<() => void>();
  constructor(private source: FilesSource) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.cache = Object.assign(Object.create(null), this.cache); this.listeners.forEach(listener => listener()); }
  private watchGeneration = 0;
  private paused = false;
  private deferred = false;
  pause(paused: boolean) {
    this.paused = paused;
    if (!paused && this.deferred) { this.deferred = false; this.refresh(); }
  }
  watch(paths: string[], changed: (error?: string, ready?: boolean) => void) {
    const generation = ++this.watchGeneration;
    const release = this.source.watch(paths, (error, ready) => {
      if (generation !== this.watchGeneration) return;
      this.refresh();
      changed(error, ready);
    });
    return () => { if (generation === this.watchGeneration) this.watchGeneration++; release(); };
  }
  refresh(force = false) {
    if (this.paused && !force) { this.deferred = true; return; }
    const paths = [...new Set(['', ...this.directories(), ...this.pending.keys()])];
    this.invalidate();
    for (const path of paths) void this.load(path);
  }
  discover(expanded: string[], hideIgnored = false) {
    if (this.paused) return;
    void this.load('');
    for (const row of this.rows(expanded, hideIgnored))
      if (row.directory && expanded.includes(row.path)) void this.load(row.path);
  }
  cancel() {
    for (const [path, request] of this.pending) {
      request.controller.abort(); this.stale.add(path);
      if (this.cache[path]?.slow) this.cache[path] = { ...this.cache[path], slow: false };
    }
    this.pending.clear();
  }
  invalidate() { this.cancel(); for (const path of Object.keys(this.cache)) this.stale.add(path); }
  private stale = new Set<string>();
  load(path: string): Promise<Listing> {
    const pending = this.pending.get(path);
    if (pending) return pending.promise;
    if (this.cache[path] && !this.stale.has(path)) return Promise.resolve(this.cache[path]);
    const controller = new AbortController();
    let cancel!: () => void;
    const cancelled = new Promise<Listing>(resolve => { cancel = () => resolve({ error: 'Listing cancelled' }); });
    controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) { this.cache[path] = { ...this.cache[path], slow: true }; this.publish(); }
    }, 800);
    const request = Promise.resolve().then(() => controller.signal.aborted ? { error: "Listing cancelled" } : this.source.list(path, controller.signal)).then(listing => {
      if (controller.signal.aborted) return { error: 'Listing cancelled' };
      if (listing.error) throw Error(listing.error);
      const entries = [...(listing.entries ?? [])].sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path));
      const previous = this.cache[path]?.entries ?? [];
      const incoming = new Map(entries.map(entry => [entry.path, entry.directory]));
      const removed = new Set(previous.filter(old => incoming.get(old.path) !== old.directory).map(old => old.path));
      const retired = (key: string) => {
        for (let ancestor = key; ancestor; ancestor = ancestor.split('/').slice(0, -1).join('/'))
          if (removed.has(ancestor)) return true;
        return false;
      };
      if (removed.size) {
        for (const key of this.nodes.keys()) if (retired(key)) this.nodes.delete(key);
        for (const key of new Set([...Object.keys(this.cache), ...this.pending.keys()])) if (retired(key)) {
          this.pending.get(key)?.controller.abort(); this.pending.delete(key); delete this.cache[key]; this.stale.delete(key);
        }
      }
      this.cache[path] = { ...listing, entries: entries.map(entry => {
        const node = this.nodes.get(entry.path) ?? { ...entry };
        node.directory = entry.directory; this.nodes.set(entry.path, node); return node;
      }), slow: false };
      this.stale.delete(path);
      this.publish();
      return this.cache[path];
    }).catch(error => {
      if (controller.signal.aborted) return { error: 'Listing cancelled' };
      this.cache[path] = { ...this.cache[path], error: String(error), slow: false };
      this.stale.delete(path);
      this.publish();
      return this.cache[path];
    });
    const promise = Promise.race([request, cancelled]).finally(() => {
      clearTimeout(timer);
      if (this.pending.get(path)?.controller === controller) this.pending.delete(path);
    });
    this.pending.set(path, { controller, promise });
    return promise;
  }
  resolved(path: string) { return !!this.cache[path]?.entries && !this.cache[path]?.error && !this.stale.has(path); }
  directories() { return Object.keys(this.cache); }
  visible(parent: string, hideIgnored: boolean) {
    const listing = this.cache[parent];
    const failed = Object.values(this.cache).some(value => value.filterError);
    const ignored = new Set(listing?.ignored);
    return (listing?.entries ?? []).filter(entry => !hideIgnored || failed || !ignored.has(entry.path));
  }
  rows(expanded: string[], hideIgnored = false): FileRow[] {
    const rows: FileRow[] = [];
    const open = new Set(expanded);
    const visit = (parent: string, level: number) => {
      const entries = this.visible(parent, hideIgnored);
      entries.forEach((entry, index) => {
        rows.push({ ...entry, parent, level, position: index + 1, size: entries.length });
        if (entry.directory && open.has(entry.path)) visit(entry.path, level + 1);
      });
    };
    visit('', 1);
    return rows;
  }
}
