import { useMemo, useState } from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import { controls } from '@moonbase/ui/controls';
import { parseRecordedPatch, type PatchLine } from './recorded-patch.ts';
import { getFindSourceProps } from './part-find.tsx';

/** Characters of unparsed source shown per page. */
const sourcePageUnits = 16000;

export function RecordedPatch({
  text,
  complete,
  numbered = false,
  findStart = null,
}: {
  text: string;
  complete: boolean;
  numbered?: boolean;
  /** The active Find match's source offset. */
  findStart?: number | null;
}) {
  const parsed = useMemo(
    () =>
      numbered
        ? { fallback: 'Recorded numbered diff fallback. Line numbers are shown exactly as stored.' }
        : parseRecordedPatch(text, complete),
    [text, complete, numbered],
  );
  const [page, setPage] = useState(0);
  const [revealed, setRevealed] = useState<number | null>(null);
  // A newly active Find match turns to its source page once.
  if (findStart !== revealed) {
    setRevealed(findStart);
    if (findStart !== null && findStart < text.length)
      setPage(Math.floor(findStart / sourcePageUnits));
  }
  const lastPage = Math.max(0, Math.ceil(text.length / sourcePageUnits) - 1);
  let start = Math.min(page, lastPage) * sourcePageUnits;
  let end = Math.min(start + sourcePageUnits, text.length);
  if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start--;
  if (text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end++;
  return (
    <>
      <p data-find-ignore {...stylex.props(styles.caption)}>
        Historical record · read only
      </p>
      {'fallback' in parsed ? (
        <>
          <p data-find-ignore {...stylex.props(styles.caption)}>
            {parsed.fallback}
          </p>
          <pre tabIndex={0} {...getFindSourceProps(start, end)} {...stylex.props(styles.source)}>
            {text.slice(start, end)}
          </pre>
          {text.length > sourcePageUnits && (
            <div {...stylex.props(styles.pages)}>
              <Button
                {...stylex.props(controls.button, controls.quietButton)}
                disabled={start === 0}
                onClick={() => setPage(Math.max(0, page - 1))}>
                Previous source
              </Button>
              <span data-find-ignore {...stylex.props(styles.caption)}>
                Source {start.toLocaleString()}–{end.toLocaleString()} of{' '}
                {text.length.toLocaleString()} characters · Copy reads the complete source
              </span>
              <Button
                {...stylex.props(controls.button, controls.quietButton)}
                disabled={end >= text.length}
                onClick={() => setPage(page + 1)}>
                Next source
              </Button>
            </div>
          )}
        </>
      ) : (
        parsed.files.map((file, index) => (
          <div key={index}>
            <p data-find-ignore {...stylex.props(styles.caption)}>
              {file.old} → {file.next}
            </p>
            <div
              tabIndex={0}
              role="region"
              aria-label="Recorded unified patch"
              {...stylex.props(styles.source)}>
              <table {...stylex.props(styles.table)}>
                <thead data-find-ignore>
                  <tr>
                    <th>Old</th>
                    <th>New</th>
                    <th>Recorded source</th>
                  </tr>
                </thead>
                <tbody>
                  {file.hunks.map((hunk, i) => (
                    <Hunk key={i} hunk={hunk} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </>
  );
}
function Hunk({ hunk }: { hunk: { old: number; next: number; lines: PatchLine[] } }) {
  return (
    <>
      <tr>
        <td colSpan={3} data-find-ignore {...stylex.props(styles.caption)}>
          Hunk · old {hunk.old}, new {hunk.next}
        </td>
      </tr>
      {hunk.lines.map((line, index) => (
        <tr
          key={index}
          {...stylex.props(
            line.kind === 'added' && styles.added,
            line.kind === 'removed' && styles.removed,
          )}>
          <td data-find-ignore {...stylex.props(styles.number)}>
            {line.old}
          </td>
          <td data-find-ignore {...stylex.props(styles.number)}>
            {line.next}
          </td>
          <td
            {...(line.start === undefined
              ? {}
              : getFindSourceProps(line.start, line.start + line.text.length))}
            {...stylex.props(styles.line)}>
            {line.text}
          </td>
        </tr>
      ))}
    </>
  );
}
const styles = stylex.create({
  caption: {
    color: colors.secondary,
    fontSize: type.small,
    overflowWrap: 'anywhere',
    lineHeight: 1.6,
  },
  source: {
    fontFamily: type.mono,
    fontSize: type.body,
    lineHeight: 1.6,
    maxHeight: 320,
    overflow: 'auto',
    whiteSpace: 'pre',
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    padding: space.sm,
    marginBlock: space.sm,
    marginInline: 0,
  },
  table: { borderCollapse: 'collapse', width: '100%', textAlign: 'left', fontWeight: 400 },
  number: {
    color: colors.secondary,
    textAlign: 'right',
    paddingBlock: 0,
    paddingInline: space.sm,
    userSelect: 'none',
    verticalAlign: 'top',
  },
  line: { whiteSpace: 'pre', paddingBlock: 0, paddingInline: space.sm },
  added: { backgroundColor: colors.selected },
  removed: { backgroundColor: colors.warningSurface },
  pages: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.xs },
});
