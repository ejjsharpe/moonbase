import type { ChatTranscript, ChatTranscriptPart } from '@moonbase/contracts/chat';
import { createHash } from 'node:crypto';
import { previewText } from '../text.ts';

/** Long reads yield to other work after this many parts. */
export const partsPerTurn = 32;
export const getLabel = (value: string, fallback = 'Tool') =>
  previewText(value, 128).text.replaceAll('\0', '').trim() || fallback;
export type Part = {
  id: string;
  kind: ChatTranscriptPart['kind'];
  role: ChatTranscriptPart['role'];
  encoding: ChatTranscriptPart['encoding'];
  /** Encoded once, so content reads slice it and caches measure it without copying. */
  value: Buffer;
  /** Identity bound into every revision of this value, fixed when the part is first built. */
  evidence: string;
  extra: Partial<ChatTranscriptPart>;
  /** Facts derived from `value`, computed on first use and shared by relabelled copies. */
  memo: { revision?: string; preview?: { text: string; truncated: boolean } };
};
export function makePart(
  id: string,
  kind: ChatTranscriptPart['kind'],
  role: ChatTranscriptPart['role'],
  value: string | Buffer,
  extra: Partial<ChatTranscriptPart> = {},
  evidence = '',
): Part {
  if (typeof value === 'string' && !value.isWellFormed()) {
    value = '';
    extra = { ...extra, availability: 'unavailable' };
  }
  const encoding = typeof value === 'string' ? 'utf8' : 'base64';
  return {
    id,
    kind,
    role,
    encoding,
    value: typeof value === 'string' ? Buffer.from(value) : value,
    extra,
    evidence: JSON.stringify([id, kind, role, encoding, evidence]),
    memo: {},
  };
}
export const hashPrefix = (part: Part, bytes: number) =>
  createHash('sha256').update(part.evidence).update(part.value.subarray(0, bytes)).digest('hex');
export const getRevision = (part: Part) =>
  (part.memo.revision ??= hashPrefix(part, part.value.length));
export const isAvailable = (part: Part) => (part.extra.availability ?? 'available') === 'available';
/** Enough leading bytes for a 256-byte preview to know whether it was truncated. */
const previewWindowBytes = 1024;
/**
 * Upgrades a running response's available text parts, in order, to carry their whole text while
 * the page's text stays within `budget` in all; the rest keep their previews.
 */
export function giveWholeText(page: ChatTranscriptPart[], parts: Part[], budget: number) {
  let spent = page.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0);
  for (const [index, part] of parts.entries()) {
    const described = page[index]!;
    if (part.kind !== 'text' || part.encoding !== 'utf8' || !isAvailable(part)) continue;
    if (!described.truncated) continue;
    const next = spent - Buffer.byteLength(described.text) + part.value.length;
    if (next > budget) continue;
    page[index] = { ...described, text: part.value.toString('utf8'), truncated: false };
    spent = next;
  }
}
export function describePart(part: Part): ChatTranscriptPart {
  const bytes = part.value.length;
  return {
    partId: part.id,
    kind: part.kind,
    role: part.role,
    availability: 'available',
    encoding: part.encoding,
    bytes,
    revision: getRevision(part),
    ...(part.encoding === 'utf8'
      ? (part.memo.preview ??= previewText(
          part.value.subarray(0, previewWindowBytes).toString('utf8'),
          256,
        ))
      : { text: '', truncated: bytes > 0 }),
    ...part.extra,
  };
}
export type TranscriptValue = {
  id: string;
  kind: ChatTranscriptPart['kind'];
  role: ChatTranscriptPart['role'];
  value: string | { json: unknown } | { image: string };
  extra: Partial<ChatTranscriptPart>;
};
export function makeValuePart({ id, kind, role, value, extra }: TranscriptValue): Part {
  if (typeof value === 'string') return makePart(id, kind, role, value, extra);
  if ('json' in value) return makePart(id, kind, role, JSON.stringify(value.json), extra);
  const image = Buffer.from(value.image, 'base64');
  return image.toString('base64') === value.image
    ? makePart(id, kind, role, image, extra)
    : makePart(id, kind, role, Buffer.alloc(0), { ...extra, availability: 'unavailable' });
}
export function summarizeThinking(parts: readonly Part[]): ChatTranscript['thinking'] {
  const thinking = parts.filter((part) => part.kind === 'thinking');
  if (thinking.some(isAvailable)) return 'available';
  return thinking.length ? 'redacted' : 'none';
}
export type TranscriptParts = {
  /** Parts in display order; live sources build each one only when a reader reaches it. */
  parts: Iterable<Part> | AsyncIterable<Part>;
  thinking: ChatTranscript['thinking'];
};
