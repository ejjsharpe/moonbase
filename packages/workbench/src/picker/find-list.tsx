import * as stylex from '@stylexjs/stylex';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { FileIcon } from '@moonbase/ui/file-icons';
import type { FindMatch, listFindMatches } from './find-matches.ts';
import { MarkedRanges } from './marked-text.tsx';
import { styles } from './picker-styles.ts';

/** Find's matches, grouped under each file; each item's value is its match key. */
export function FindList({
  files,
  activate,
}: {
  files: ReturnType<typeof listFindMatches>;
  activate: (match: FindMatch) => void;
}) {
  let at = 0;
  return files.map((file) => (
    <Autocomplete.Group key={file.path} aria-label={file.path} {...stylex.props(styles.group)}>
      <div {...stylex.props(styles.fileHeading)}>
        <span {...stylex.props(styles.icon)}>
          <FileIcon path={file.path} />
        </span>
        <span {...stylex.props(styles.label)}>{file.path.split('/').at(-1)}</span>
        <span {...stylex.props(styles.detail, styles.trailing)}>{file.matches.length}</span>
      </div>
      {file.matches.map((hit) => (
        <Autocomplete.Item
          key={hit.key}
          value={hit.key}
          index={at++}
          aria-label={`Line ${hit.match.line}: ${hit.match.text.trim()}`}
          {...stylex.props(styles.row, styles.matchRow)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => activate(hit)}>
          <span {...stylex.props(styles.lineNumber)}>{hit.match.line}</span>
          <span {...stylex.props(styles.label, styles.code)}>
            <MarkedRanges text={hit.match.text} ranges={hit.match.ranges} trim />
          </span>
        </Autocomplete.Item>
      ))}
    </Autocomplete.Group>
  ));
}
