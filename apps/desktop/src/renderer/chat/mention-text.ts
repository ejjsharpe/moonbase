import {
  findChatMentionStarts,
  formatChatMention,
  isChatMentionEnd,
  type ChatMention,
} from '@moonbase/contracts/chat';

/** An `@` being typed before the caret: where it starts and what follows it. */
export type MentionQuery = { start: number; query: string };

/** The `@query` the caret is typing, unless it is an existing mention or follows a word. */
export function findMentionQuery(
  text: string,
  caret: number,
  mentions: readonly ChatMention[],
): MentionQuery | null {
  const match = /(?:^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1]!,
    start = caret - query.length - 1;
  // The caret resting at the end of a picked mention is not a new query.
  if (mentions.some((mention) => mention.path === query) && isChatMentionEnd(text, caret))
    return null;
  return { start, query };
}

/** Replaces `@query` with the mention and a space, returning the text and the caret after it. */
export function insertMention(text: string, query: MentionQuery, caret: number, path: string) {
  const token = formatChatMention(path) + ' ';
  const after = text.slice(caret).replace(/^ /, '');
  return {
    text: text.slice(0, query.start) + token + after,
    caret: query.start + token.length,
  };
}

/** Each mention's spellings in the text, ordered and not overlapping. */
export function findMentionRanges(text: string, mentions: readonly ChatMention[]) {
  const ranges: { start: number; end: number; path: string }[] = [];
  for (const mention of mentions) {
    const length = formatChatMention(mention.path).length;
    for (const start of findChatMentionStarts(text, mention.path))
      ranges.push({ start, end: start + length, path: mention.path });
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  return ranges.filter((range, index) => !index || range.start >= ranges[index - 1]!.end);
}

/** Backspace at a mention's end deletes the whole mention, as with a chip. */
export function removeMentionBefore(text: string, caret: number, mentions: readonly ChatMention[]) {
  const range = findMentionRanges(text, mentions).find((r) => r.end === caret);
  if (!range) return null;
  return { text: text.slice(0, range.start) + text.slice(range.end), caret: range.start };
}
