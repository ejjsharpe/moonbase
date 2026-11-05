import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';
import type { TranscriptContentState } from '@moonbase/application/chat';

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
  const [selected, setSelected] = useState(false);
  const [retained, setRetained] = useState({ identity, body: current });
  const copyIntent = useRef<{ identity: string; body: PartBody } | null>(null);
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      setSelected(
        !!root.current &&
          !!selection &&
          !selection.isCollapsed &&
          selection.rangeCount > 0 &&
          selection.getRangeAt(0).intersectsNode(root.current),
      );
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);
  const waiting =
    retained.body.loaded &&
    current.part.truncated &&
    !current.complete &&
    (retained.body.part.bytes !== current.part.bytes ||
      retained.body.part.revision !== current.part.revision) &&
    current.text.length < retained.body.text.length &&
    contents.some(
      (content) =>
        JSON.stringify(content.source) === JSON.stringify(retained.body.source) &&
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
