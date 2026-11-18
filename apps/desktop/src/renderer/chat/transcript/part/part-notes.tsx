import type { ReactNode } from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import type { TranscriptContentState } from '@moonbase/application/chat';
import type { ChatTranscriptPart } from '@moonbase/contracts/chat';
import { Note } from '../transcript-note.tsx';

/**
 * What a part says under its content: which version or range it shows, what the tool dropped, a
 * failed read, and Read more for a part read in pages.
 */
export function PartNotes({
  part,
  content,
  readable,
  held,
  retainedFrom,
  excerpt,
  matchDiffers,
  load,
}: {
  part: ChatTranscriptPart;
  content: TranscriptContentState | undefined;
  readable: boolean;
  /** The reader's selection holds an earlier version of the output. */
  held: boolean;
  /** Where the shown content starts in the part's source. */
  retainedFrom: number;
  /** The active match's original-source excerpt, when the rendering can't locate it. */
  excerpt: ReactNode;
  /** The active Find match isn't in the loaded source. */
  matchDiffers: boolean;
  load(restart?: boolean): void;
}) {
  return (
    <>
      {held && (
        <Note role="status">
          Showing previously read output. Copy uses this version; latest progress remains above.
        </Note>
      )}
      {part.kind === 'arguments' && part.toolName === 'write' && (
        <Note>
          Captured write content is in the arguments. No before/after diff was recorded here.
        </Note>
      )}
      {excerpt}
      {matchDiffers && (
        <Note role="alert">The saved match differs from this source. Refresh results.</Note>
      )}
      {part.pairing && part.pairing !== 'matched' && (
        <Note>Tool result pairing: {part.pairing}.</Note>
      )}
      {(!!part.droppedBytes || !!part.droppedLines) && (
        <Note>
          {(part.droppedBytes ?? 0).toLocaleString()} earlier bytes / {part.droppedLines ?? 0} lines
          were not retained by the tool.
        </Note>
      )}
      {!!retainedFrom && (
        <Note>
          Showing retained content from byte {retainedFrom.toLocaleString()}. Copy still reads the
          complete selected source.{' '}
          <Button {...stylex.props(controls.button)} onClick={() => load(true)}>
            Read from start
          </Button>
        </Note>
      )}
      {content?.error && (
        <Note warning role="alert">
          {content.error}{' '}
          <Button
            {...stylex.props(controls.button)}
            onClick={() => load(content.status === 'source-changed')}>
            Retry content
          </Button>
        </Note>
      )}
      {/* A shown part reads its content by itself, so only a part read in pages offers more. It
          stays in place while a page loads: a line that came and went with every read would move
          the rows below it, and the list following the end with them. */}
      {readable && content?.nextCursor && (
        <Button
          {...stylex.props(controls.button, controls.quietButton)}
          disabled={content.status === 'loading'}
          onClick={() => load()}>
          Read more · {content.loadedBytes.toLocaleString()} of {part.bytes.toLocaleString()} bytes
        </Button>
      )}
    </>
  );
}
