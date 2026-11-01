/** Measured row geometry is independent of React and of which logical rows are mounted. */
export class FilesViewport {
  private heights = new Map<string, number>();
  private width = 0;
  keys: string[] = [];
  offsets: number[] = [0];
  setRows(keys: string[], width: number, top = 0) {
    const anchor = this.indexAt(top);
    const key = this.keys[anchor];
    const within = top - (this.offsets[anchor] ?? 0);
    if (width !== this.width) { this.heights.clear(); this.width = width; }
    this.keys = keys;
    this.offsets = [0];
    for (const key of keys) this.offsets.push(this.offsets.at(-1)! + (this.heights.get(key) ?? 28));
    const next = keys.indexOf(key);
    return next < 0 ? top : this.offsets[next] + Math.min(within, this.offsets[next + 1] - this.offsets[next] - 1);
  }
  anchor(top: number) {
    const index = this.indexAt(top);
    const path = this.keys[index];
    return path && !path.startsWith("\0") ? { path, offset: Math.max(0, top - this.offsets[index]) } : undefined;
  }
  measure(key: string, height: number) {
    if (height <= 0) return false;
    if (height === 28) return this.heights.delete(key);
    if (this.heights.get(key) === height) return false;
    this.heights.set(key, height); return true;
  }
  get height() { return this.offsets.at(-1)!; }
  indexAt(offset: number) {
    let low = 0, high = this.keys.length;
    while (low < high) { const mid = (low + high) >>> 1; if (this.offsets[mid + 1] <= offset) low = mid + 1; else high = mid; }
    return low;
  }
  mounted(top: number, height: number, pinned: string[] = []) {
    const indexes = new Set<number>();
    const start = this.indexAt(Math.max(0, top - 280));
    const end = Math.min(this.keys.length, this.indexAt(top + height + 280) + 1);
    for (let i = start; i < end; i++) indexes.add(i);
    for (const key of pinned) { const index = this.keys.indexOf(key); if (index >= 0) indexes.add(index); }
    return [...indexes].sort((a, b) => a - b);
  }
  reveal(key: string, top: number, height: number) {
    const index = this.keys.indexOf(key);
    if (index < 0) return top;
    if (this.offsets[index] < top) return this.offsets[index];
    return this.offsets[index + 1] > top + height ? Math.max(0, this.offsets[index + 1] - height) : top;
  }
}
