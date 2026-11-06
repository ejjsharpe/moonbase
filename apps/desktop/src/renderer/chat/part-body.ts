import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import type { TranscriptContentState } from '@moonbase/application/chat';
import { readingPin, useReadingPin } from './reading-pin.ts';

type PartBody = {
  source: ChatTranscriptSource;
  part: ChatTranscriptPart;
  text: string;
  complete: boolean;
  loaded: boolean;
  retainedFrom: number;
  loadedBytes: number;
};

export function usePartBody(
  identity: string,
  current: PartBody,
  enabled: boolean,
  contents: readonly TranscriptContentState[],
) {
  const root = useRef<HTMLPreElement>(null);
  // A selection inside the output holds the version the reader selected.
  const selected = (useReadingPin(root, enabled) & readingPin.selected) !== 0;
  const [retained, setRetained] = useState({ identity, body: current });
  const copyIntent = useRef<{ identity: string; body: PartBody } | null>(null);
  const waiting =
    retained.body.loaded &&
    current.part.truncated &&
    !current.complete &&
    (retained.body.part.bytes !== current.part.bytes ||
      retained.body.part.revision !== current.part.revision) &&
    current.text.length < retained.body.text.length &&
    contents.some(
      (content) =>
        areJsonValuesEqual(content.source, retained.body.source) &&
        content.selection.partId === retained.body.part.partId &&
        content.selection.bytes === retained.body.part.bytes &&
        content.selection.revision === retained.body.part.revision &&
        content.retainedFrom === retained.body.retainedFrom &&
        content.loadedBytes >= retained.body.loadedBytes,
    );
  const keep = enabled && retained.identity === identity && (selected || waiting);
  if (!keep && (retained.identity !== identity || retained.body !== current))
    setRetained({ identity, body: current });
  const body = keep ? retained.body : current;
  const takeCopyBody = useCallback(() => {
    const captured = copyIntent.current;
    copyIntent.current = null;
    return captured && captured.identity !== identity ? null : (captured?.body ?? body);
  }, [body, identity]);
  return {
    root,
    body,
    held: body !== current,
    takeCopyBody,
    copyProps: {
      onPointerDown: () => {
        copyIntent.current = { identity, body };
      },
      onPointerCancel: () => {
        copyIntent.current = null;
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (!event.repeat)
          copyIntent.current = [' ', 'Enter'].includes(event.key) ? { identity, body } : null;
      },
    },
  };
}
