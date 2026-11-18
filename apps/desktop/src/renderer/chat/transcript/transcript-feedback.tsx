import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { space } from '@moonbase/ui/tokens.stylex';
import type { TranscriptNotice, TranscriptState } from '@moonbase/application/chat';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { ReadingColumn } from './transcript-column.tsx';
import { Note } from './transcript-note.tsx';

export const snapshotLabels = {
  idle: 'Idle',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  uncertain: 'Uncertain',
};

/**
 * What the transcript says above its rows: how the conversation ended, a native action's notice,
 * a failed history read with Retry, the live updates' state, and a held selection.
 */
export function TranscriptFeedback({
  snapshot,
  notice,
  transcript,
  held,
  onRetry,
}: {
  snapshot: ChatSnapshot | null;
  notice: TranscriptNotice | null;
  /** The latest transcript, whatever the view holds. */
  transcript: Pick<TranscriptState, 'error' | 'observation'>;
  /** The view holds the response the reader's selection is in. */
  held: boolean;
  onRetry(): void;
}) {
  const failed = !!snapshot && ['failed', 'uncertain'].includes(snapshot.state);
  return (
    <ReadingColumn>
      {/* Idle and running need no line; stopped and failed say so. */}
      {snapshot && !['idle', 'running'].includes(snapshot.state) && (
        <Note
          label="Conversation status"
          warning={failed}
          role={failed ? 'alert' : 'status'}
          style={styles.line}>
          {snapshotLabels[snapshot.state]}
          {snapshot.message && ` · ${snapshot.message}`}
        </Note>
      )}
      {notice && (
        <Note
          warning={notice.tone === 'error'}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          style={styles.line}>
          {notice.text}
        </Note>
      )}
      {transcript.error && (
        <Note warning role="alert">
          {transcript.error}{' '}
          <Button {...stylex.props(controls.button)} onClick={onRetry}>
            Retry history
          </Button>
        </Note>
      )}
      {transcript.observation === 'reconnecting' && (
        <Note role="status" style={styles.line}>
          Reconnecting to live updates…
        </Note>
      )}
      {transcript.observation === 'failed' && (
        <Note warning role="alert">
          Live updates stopped. Reopen the conversation to refresh.
        </Note>
      )}
      {held && (
        <Note role="status">
          The response changed. Your selection is retained; Jump to latest to read the current
          output.
        </Note>
      )}
    </ReadingColumn>
  );
}

const styles = stylex.create({
  line: { padding: space.sm, margin: 0 },
});
