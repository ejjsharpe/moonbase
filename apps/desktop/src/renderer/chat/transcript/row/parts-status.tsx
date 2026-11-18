import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import type { LiveEntry, TranscriptManifestState } from '@moonbase/application/chat';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { useTranscript } from '../transcript-context.ts';
import { Note } from '../transcript-note.tsx';

/**
 * What a row says under its parts about the parts themselves: more to read, descriptions released
 * from memory, a failed read, redacted thinking, or a saved Find part that is gone.
 */
export function PartsStatus({
  source,
  transcript,
  manifest,
  parts,
  missingMatch,
}: {
  source: ChatTranscriptSource | undefined;
  transcript: LiveEntry['transcript'];
  manifest: TranscriptManifestState | null;
  parts: readonly ChatTranscriptPart[];
  /** The revealed Find match's part is not among the loaded parts, and won't be. */
  missingMatch: boolean;
}) {
  const { act, selection } = useTranscript();
  return (
    <>
      {missingMatch && (
        <Note warning role="alert">
          The saved Find part is unavailable. Refresh results.
        </Note>
      )}
      {transcript?.thinking === 'redacted' && !parts.some((part) => part.kind === 'thinking') && (
        <Note>Thinking is redacted by the provider.</Note>
      )}
      {source && (manifest ? manifest.nextCursor : transcript?.nextCursor) && (
        <Button
          {...stylex.props(controls.button)}
          disabled={manifest?.status === 'loading'}
          onClick={() => void act(selection.loadMoreTranscriptParts(source))}>
          Load more parts
        </Button>
      )}
      {source && manifest?.omittedParts ? (
        <Note>
          Earlier part descriptions were released from memory.{' '}
          <Button
            {...stylex.props(controls.button)}
            onClick={() => void act(selection.loadTranscriptManifest(source, true))}>
            Reload parts
          </Button>
        </Note>
      ) : null}
      {source && manifest?.error && (
        <Note warning role="alert">
          {manifest.error}{' '}
          <Button
            {...stylex.props(controls.button)}
            onClick={() =>
              void act(
                selection.loadTranscriptManifest(source, manifest.status === 'source-changed'),
              )
            }>
            Retry parts
          </Button>
        </Note>
      )}
    </>
  );
}
