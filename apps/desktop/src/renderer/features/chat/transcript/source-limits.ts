/**
 * Above these, recorded source is shown literally rather than highlighted or parsed as a patch.
 * `units` counts UTF-16 code units (`string.length`): it bounds the work, not exact storage, and
 * avoids encoding the source on every render.
 */
export const structuredSourceLimits = { units: 64 * 1024, lines: 2000 } as const;

export function fitsStructuredSource(text: string) {
  if (text.length > structuredSourceLimits.units) return false;
  let lines = 1;
  for (
    let index = text.indexOf('\n');
    index !== -1 && lines <= structuredSourceLimits.lines;
    index = text.indexOf('\n', index + 1)
  )
    lines++;
  return lines <= structuredSourceLimits.lines;
}
