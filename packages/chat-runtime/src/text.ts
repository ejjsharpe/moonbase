import { fail } from '@moonbase/contracts/errors';

/** Checks an opaque cursor: well-formed, NUL-free text of at most 1 KiB. */
export function checkCursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.includes('\0') ||
    !value.trim() ||
    Buffer.byteLength(value) > 1024
  )
    return fail('InvalidInput', 'Chat text is empty, invalid Unicode, or exceeds its limit.');
  return value;
}

/** Cuts `text` to at most `bytes` UTF-8 bytes without splitting a character. */
export function previewText(text: string, bytes = 4096) {
  let result = '',
    used = 0;
  for (const char of text.toWellFormed()) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes) break;
    result += char;
    used += size;
  }
  return { text: result, truncated: result.length < text.length };
}
