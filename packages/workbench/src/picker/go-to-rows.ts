import type { CheckoutTarget, FileTarget } from '@moonbase/contracts/workspace';
import { checkoutKey, fileKey, type LookupSnapshot } from '@moonbase/application/editor';
import { checkoutName } from '@moonbase/ui/projects';
import { matchLabel, type LabelMatch } from './match-label.ts';

/** Something besides a file that Go to can jump to, supplied by the workbench or its app. */
export type PickerEntry = {
  id: string;
  kind: 'chat' | 'project' | 'command';
  label: string;
  detail?: string;
  shortcut?: string;
  /** Chats listed under Recent before anything is typed. */
  recent?: boolean;
  /** A project's tile identity: every checkout of one repository shares its hue. */
  projectId?: string;
  run: () => void;
};

/** A Go to result: a file to open or an entry to run, under its group's heading. */
export type GoToRow = {
  key: string;
  group: string;
  kind: 'file' | 'chat' | 'project' | 'command';
  label: string;
  positions: number[];
  detail?: string;
  shortcut?: string;
  projectId?: string;
} & ({ file: FileTarget; entry?: undefined } | { entry: PickerEntry; file?: undefined });

/**
 * Go to's rows for `query`: Recent files, chats and Projects before anything is typed; the
 * checkout's files, then chats, projects and commands that match; only commands after `>`.
 */
export function listGoToRows({
  query,
  entries,
  files,
  checkout,
}: {
  query: string;
  entries: PickerEntry[];
  files: LookupSnapshot;
  checkout: CheckoutTarget | undefined;
}): GoToRow[] {
  const rows: GoToRow[] = [];
  const entry = (item: PickerEntry, group: string, matched: LabelMatch): GoToRow => ({
    key: item.kind + ':' + item.id,
    group,
    kind: item.kind,
    label: item.label,
    positions: matched.positions,
    detail: item.detail,
    shortcut: item.shortcut,
    projectId: item.projectId,
    entry: item,
  });
  const ranked = (kind: PickerEntry['kind'], text: string) =>
    entries
      .filter((item) => item.kind === kind)
      .map((item) => ({ item, matched: matchLabel(item.label, text) }))
      .filter((row): row is { item: PickerEntry; matched: LabelMatch } => !!row.matched)
      .sort((a, b) => b.matched.score - a.matched.score);
  if (query.startsWith('>')) {
    for (const { item, matched } of ranked('command', query.slice(1)))
      rows.push(entry(item, '', matched));
    return rows;
  }
  const fileRows = (group: string, limit: number) => {
    if (!checkout) return;
    const scope = checkoutKey(checkout);
    for (const row of files.rows
      .filter((row) => checkoutKey(row.checkout) === scope)
      .slice(0, limit)) {
      const file = { checkout: row.checkout, path: row.path };
      rows.push({
        key: 'file:' + fileKey(file),
        group,
        kind: 'file',
        label: row.path,
        positions: row.positions,
        file,
      });
    }
  };
  if (!query.trim()) {
    fileRows('Recent', 5);
    for (const item of entries.filter((item) => item.kind === 'chat' && item.recent).slice(0, 3))
      rows.push(entry(item, 'Recent', { positions: [], score: 0 }));
    for (const { item, matched } of ranked('project', ''))
      rows.push(entry(item, 'Projects', matched));
    return rows;
  }
  fileRows(checkout ? 'Files · ' + checkoutName(checkout) : '', 8);
  for (const { item, matched } of ranked('chat', query).slice(0, 5))
    rows.push(entry(item, 'Chats', matched));
  for (const { item, matched } of ranked('project', query).slice(0, 5))
    rows.push(entry(item, 'Projects', matched));
  for (const { item, matched } of ranked('command', query).slice(0, 3))
    rows.push(entry(item, 'Commands', matched));
  return rows;
}

/** Consecutive rows that share a group, in order, so each heading is shown once. */
export function groupGoToRows(rows: GoToRow[]): { group: string; rows: GoToRow[] }[] {
  const groups: { group: string; rows: GoToRow[] }[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.group === row.group) last.rows.push(row);
    else groups.push({ group: row.group, rows: [row] });
  }
  return groups;
}
