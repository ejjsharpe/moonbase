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
