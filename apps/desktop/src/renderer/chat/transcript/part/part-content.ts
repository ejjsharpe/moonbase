import { useCallback, useEffect, useMemo } from 'react';
import type { TranscriptContentState } from '@moonbase/application/chat';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { useTranscript } from '../transcript-context.ts';

/**
 * A part's loaded content: its retained chunks, decoded from `base`, or the summary text when the
 * part is not truncated. `wanted` reads a truncated part's first chunk.
 */
export function usePartContent({
  source,
  part,
  contents,
  wanted,
}: {
  source: ChatTranscriptSource;
  part: ChatTranscriptPart;
  /** Loaded content of this part's source. */
  contents: readonly TranscriptContentState[];
  wanted: boolean;
}) {
  const { act, selection } = useTranscript();
  const content = contents.find(
    (item) =>
      item.selection.partId === part.partId &&
      item.selection.revision === part.revision &&
      item.selection.bytes === part.bytes,
  );
  const load = useCallback(
    (restart = false) => {
      void act(
        selection.loadTranscriptPart(
          source,
          { partId: part.partId, bytes: part.bytes, revision: part.revision },
          restart,
        ),
      );
    },
    [act, selection, source, part.partId, part.bytes, part.revision],
  );
  useEffect(() => {
    if (wanted && part.truncated && !content) load();
  }, [wanted, part.truncated, content, load]);
  const base = content?.chunks[0]?.textOffset ?? 0;
  const original = useMemo(() => {
    if (content?.chunks.length) return decodeText(content);
    return part.truncated ? '' : part.text;
  }, [content, part]);
  return { content, load, base, original };
}

function decodeText(content: TranscriptContentState) {
  return content.chunks.map((chunk) => (chunk.encoding === 'utf8' ? chunk.data : '')).join('');
}
