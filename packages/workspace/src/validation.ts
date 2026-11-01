import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { ApplicationError, maximumFileBytes, type CheckoutTarget, type EditorRecovery, type FileDocument } from '@moonbase/application/client';
export const fail = (code: ApplicationError['code'], message: string): never => { throw new ApplicationError({ code, message }); };
export const ensure: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) fail('InvalidInput', message); };
export function identifier(value: unknown): asserts value is string { ensure(typeof value === 'string' && /^[\w.-]{1,160}$/.test(value), 'Invalid client/request identity.'); }
export function path(value: unknown, directory = false): asserts value is string {
  ensure(typeof value === 'string' && value.length <= 4096 && (directory || !!value) && !isAbsolute(value) && !/[\\\0]/.test(value) &&
    (value === '' || !value.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')), 'Use an exact checkout-relative path without traversal, links or metadata.');
}
export function checkout(value: CheckoutTarget) {
  ensure(value && typeof value === 'object' && typeof value.root === 'string' && isAbsolute(value.root) && !value.root.includes('\0') && value.root.length <= 4096, 'Invalid checkout root.');
  for (const key of ['hostId', 'checkoutId', 'projectId', 'branch'] as const) ensure(typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 4096, 'Invalid checkout identity.');
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function document(bytes: Buffer): FileDocument {
  ensure(bytes.length <= maximumFileBytes && !bytes.includes(0), 'Text unavailable: binary or exceeds 2 MiB.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail('InvalidInput', 'Text unavailable: invalid UTF-8.'); }
  return { text, version: hash(bytes) };
}
export function textDocument(text: string) { ensure(typeof text === 'string', 'Invalid text.'); const value = document(Buffer.from(text)); ensure(value.text === text, 'Invalid Unicode text.'); return value; }
export const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export function recovery(state: EditorRecovery, clientId: string) {
  ensure(record(state) && state.version === 1 && state.clientId === clientId && Buffer.byteLength(JSON.stringify(state)) <= 32 * 1024 * 1024, 'Invalid or oversized recovery state.');
  ensure(Array.isArray(state.checkouts) && state.checkouts.length <= 128 && record(state.views) && Array.isArray(state.drafts) && state.drafts.length <= 512 && Array.isArray(state.recentFiles) && state.recentFiles.length <= 1000 && Number.isFinite(state.sidebarWidth) && state.sidebarWidth >= 100 && state.sidebarWidth <= 2000, 'Invalid recovery state.');
  state.checkouts.forEach(checkout);
  const identities = new Map(state.checkouts.map(c => [c.checkoutId, c]));
  ensure(Array.isArray(state.openCheckoutIds) && state.openCheckoutIds.length <= 128 && new Set(state.openCheckoutIds).size === state.openCheckoutIds.length && state.openCheckoutIds.every(id => typeof id === 'string' && identities.has(id)), 'Invalid open checkout membership.');
  ensure(identities.size === state.checkouts.length && (state.selectedCheckoutId === null || state.openCheckoutIds.includes(state.selectedCheckoutId)), 'Invalid recovery checkout selection.');
  const target = (t: any) => { ensure(record(t), 'Invalid recovery target.'); path(t.path); checkout(t.checkout); ensure(same(identities.get(t.checkout.checkoutId), t.checkout), 'Recovery target has mismatched checkout.'); };
  const seen = new Set<string>();
  for (const draft of state.drafts) {
    target(draft?.target); textDocument(draft.text); ensure(record(draft.disk) && textDocument(draft.disk.text).version === draft.disk.version, 'Invalid recovery baseline.');
    const key = canonical(draft.target); ensure(!seen.has(key), 'Duplicate recovery draft.'); seen.add(key);
  }
  state.recentFiles.forEach(target);
  const modes = ['file', 'staged', 'unstaged', 'untracked', 'conflict'];
  for (const [id, view] of Object.entries(state.views)) {
    ensure(identities.has(id) && record(view) && Array.isArray(view.openFiles) && view.openFiles.length <= 1000 && new Set(view.openFiles).size === view.openFiles.length, 'Invalid recovery view.');
    view.openFiles.forEach(p => path(p)); path(view.active, true);
    ensure((!view.active || view.openFiles.includes(view.active)) && (view.preview === null || view.openFiles.includes(view.preview)) && record(view.fileViews) && record(view.positions), 'Invalid recovery tabs.');
    for (const [p, mode] of Object.entries(view.fileViews)) { path(p); ensure(modes.includes(mode), 'Invalid file view.'); }
    for (const [p, positions] of Object.entries(view.positions)) {
      path(p); ensure(record(positions), 'Invalid positions.');
      for (const [mode, pos] of Object.entries(positions)) {
        ensure(modes.includes(mode.replace(/:original$/, '')) && record(pos) && Number.isInteger(pos.line) && pos.line >= 1 && Number.isInteger(pos.column) && pos.column >= 1 && Number.isFinite(pos.top) && pos.top >= 0 && Number.isFinite(pos.left) && pos.left >= 0, 'Invalid editor position.');
      }
    }
    ensure(record(view.tree) && Array.isArray(view.tree.expanded) && Array.isArray(view.tree.selected) && Number.isFinite(view.tree.scroll) && view.tree.scroll >= 0 && typeof view.tree.hideIgnored === 'boolean', 'Invalid tree memory.');
    [...view.tree.expanded, ...view.tree.selected, view.tree.focus].forEach(p => path(p, true));
  }
}
