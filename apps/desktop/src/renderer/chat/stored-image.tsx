import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';
import { workbench } from '@moonbase/ui/workbench';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import type { ChatController } from '@moonbase/application/chat';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';
import {
  type ImageResources,
  checkImagePart,
  readStoredImage,
  paintStoredImage,
} from './stored-image.ts';

type ImageRequest = { source: ChatTranscriptSource; part: ChatTranscriptPart; key: string };
type Viewer = ImageRequest & { trigger: HTMLElement };
type ImageContext = {
  resources: ImageResources;
  controller: ChatController;
  enabled: boolean;
  open(viewer: Viewer): void;
  close(key: string): void;
};
const Images = createContext<ImageContext | null>(null);
export const ImageVisibility = createContext(true);

export function StoredImages({
  controller,
  resources,
  enabled,
  fallback,
  onReadingSourceChange,
  children,
}: {
  controller: ChatController;
  resources: ImageResources;
  enabled: boolean;
  fallback: RefObject<HTMLElement | null>;
  onReadingSourceChange(source: ChatTranscriptSource | null): void;
  children: ReactNode;
}) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const current = useRef<Viewer | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const open = useCallback(
    (next: Viewer) => {
      current.current = next;
      trigger.current = next.trigger;
      onReadingSourceChange(next.source);
      setViewer(next);
    },
    [onReadingSourceChange],
  );
  const close = useCallback((key: string) => {
    if (current.current?.key !== key) return;
    current.current = null;
    setViewer(null);
  }, []);
  useEffect(() => {
    // Keep the row until Base UI returns focus; the transcript then owns its normal focus pin.
    const release = () => {
      if (!current.current) onReadingSourceChange(null);
    };
    document.addEventListener('focusin', release);
    return () => {
      document.removeEventListener('focusin', release);
      onReadingSourceChange(null);
    };
  }, [onReadingSourceChange]);
  useEffect(() => {
    if (!enabled) onReadingSourceChange(null);
  }, [enabled, onReadingSourceChange]);
  const context = useMemo(
    () => ({ resources, controller, enabled, open, close }),
    [resources, controller, enabled, open, close],
  );
  return (
    <Images value={context}>
      {children}
      <Dialog.Root
        open={enabled && !!viewer}
        onOpenChange={(open) => {
          if (!open && current.current) close(current.current.key);
        }}>
        <Dialog.Portal>
          <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
          <Dialog.Popup
            {...stylex.props(workbench.document, overlays.popup, styles.viewer)}
            finalFocus={() => {
              const node = trigger.current;
              if (node?.isConnected && node.getClientRects().length) return node;
              return fallback.current?.getClientRects().length ? fallback.current : false;
            }}>
            <div {...stylex.props(controls.row, styles.header)}>
              <Dialog.Title {...stylex.props(styles.title)}>Stored image</Dialog.Title>
              <Dialog.Close {...stylex.props(controls.button)} aria-label="Close image viewer">
                Close
              </Dialog.Close>
            </div>
            <Dialog.Description {...stylex.props(styles.meta)}>
              Recorded transcript image. Preview only.
            </Dialog.Description>
            {enabled && viewer && (
              <ImageCanvas key={viewer.key} request={viewer} thumbnail={false} />
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </Images>
  );
}

export function StoredImage({
  source,
  part,
}: {
  source: ChatTranscriptSource;
  part: ChatTranscriptPart;
}) {
  const { enabled, close } = useContext(Images)!;
  const activityVisible = useContext(ImageVisibility);
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const key = JSON.stringify([source, part]);
  const request = useMemo(() => ({ source, part, key }), [source, part, key]);
  useEffect(() => {
    const node = root.current;
    if (!node || !activityVisible || !enabled) {
      setVisible(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), {
      root: node.closest('[aria-label="Chat transcript"]'),
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [activityVisible, enabled]);
  const active = enabled && activityVisible && visible;
  useEffect(() => () => close(key), [close, key, active]);
  return (
    <div ref={root} data-stored-image {...stylex.props(styles.image)}>
      <p {...stylex.props(styles.meta)}>
        {part.mimeType ?? 'Unknown type'} · {part.bytes.toLocaleString()} bytes
      </p>
      <ImageCanvas key={key} request={request} thumbnail active={active} />
    </div>
  );
}

function ImageCanvas({
  request,
  thumbnail,
  active = true,
}: {
  request: ImageRequest;
  thumbnail: boolean;
  active?: boolean;
}) {
  const { controller, resources, enabled, open } = useContext(Images)!;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState<{ ready?: boolean; error?: string; dimensions?: string }>(
    {},
  );
  const [previous, setPrevious] = useState({ request, active, enabled, retry });
  if (
    previous.request !== request ||
    previous.active !== active ||
    previous.enabled !== enabled ||
    previous.retry !== retry
  ) {
    setPrevious({ request, active, enabled, retry });
    setStatus({});
  }
  let policyError: string | undefined;
  try {
    checkImagePart(request.part);
  } catch (error) {
    policyError = (error as Error).message;
  }
  useEffect(() => {
    const node = canvas.current;
    if (!node || !active || !enabled || policyError) return;
    const job = new AbortController();
    let releaseCanvas: (() => void) | undefined;
    void (async () => {
      const image = await readStoredImage(
        controller,
        request.source,
        request.part,
        resources,
        job.signal,
      );
      try {
        releaseCanvas = await paintStoredImage(image, resources, job.signal, node, thumbnail);
        job.signal.throwIfAborted();
        setStatus({
          ready: true,
          dimensions: `${image.width.toLocaleString()} × ${image.height.toLocaleString()} pixels`,
        });
      } finally {
        image.release();
      }
    })().catch((error) => {
      releaseCanvas?.();
      if (!job.signal.aborted)
        setStatus({
          error:
            error instanceof Error
              ? error.message
              : 'Could not read or decode this stored image. Retry the preview.',
        });
    });
    return () => {
      job.abort();
      releaseCanvas?.();
    };
  }, [controller, resources, request, thumbnail, active, enabled, policyError, retry]);
  const error = policyError ?? status.error;
  const ready = active && enabled && status.ready;
  let placeholder = 'Image preview paused';
  if (active) placeholder = 'Loading image…';
  if (error) placeholder = 'Preview unavailable';
  const picture = (
    <canvas
      ref={canvas}
      width={0}
      height={0}
      hidden={!ready}
      role="img"
      aria-label={thumbnail ? 'Stored image thumbnail' : 'Recorded image'}
      {...stylex.props(thumbnail ? styles.thumbnail : styles.fullImage)}
    />
  );
  return (
    <>
      {thumbnail ? (
        <Button
          disabled={!ready}
          aria-label="View stored image"
          {...stylex.props(controls.button, styles.thumbnailFrame)}
          onClick={(event) => open({ ...request, trigger: event.currentTarget })}>
          {picture}
          {!ready && <span>{placeholder}</span>}
        </Button>
      ) : (
        <div tabIndex={0} aria-label="Image viewport" {...stylex.props(styles.viewport)}>
          {picture}
        </div>
      )}
      {(ready || thumbnail) && (
        <p aria-hidden={!ready} {...stylex.props(styles.meta, styles.caption)}>
          {status.dimensions}
          {thumbnail && ready ? ' · Open to inspect' : ''}
        </p>
      )}
      {error && (
        <p role="alert" {...stylex.props(styles.meta)}>
          {error}
        </p>
      )}
      {status.error && active && enabled && (
        <Button {...stylex.props(controls.button)} onClick={() => setRetry((value) => value + 1)}>
          Retry image
        </Button>
      )}
      {!thumbnail && !error && !ready && (
        <p role="status" {...stylex.props(styles.meta)}>
          Loading image…
        </p>
      )}
    </>
  );
}
const styles = stylex.create({
  image: { minWidth: 0, maxWidth: '100%' },
  meta: {
    color: colors.secondary,
    fontSize: type.small,
    overflowWrap: 'anywhere',
    marginBlock: space.sm,
  },
  caption: { minHeight: '1.7em' },
  thumbnailFrame: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 336,
    maxWidth: '100%',
    height: 196,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  thumbnail: { display: 'block', maxWidth: '100%', maxHeight: 180, objectFit: 'contain' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 100, backgroundColor: colors.backdrop },
  viewer: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 101,
    width: 'min(960px, calc(100vw - 32px))',
    maxHeight: 'calc(100dvh - 32px)',
    padding: space.lg,
    display: 'flex',
    flexDirection: 'column',
  },
  header: { justifyContent: 'space-between', flexShrink: 0, gap: space.md },
  title: { margin: 0, fontSize: type.heading, fontWeight: 500 },
  viewport: {
    minHeight: 0,
    overflow: 'auto',
    borderRadius: radius.control,
    ':focus-visible': { outline: `2px solid ${colors.accent}`, outlineOffset: -2 },
  },
  fullImage: { display: 'block', maxWidth: '100%', height: 'auto', marginInline: 'auto' },
});
