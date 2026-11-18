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
import { Effect } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useAtomRefresh, useAtomValue } from '@effect/atom-react';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';
import { workbench } from '@moonbase/ui/workbench';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { maximumTranscriptImageBytes, type TranscriptImage } from '../../../ipc/chat-rpcs.ts';
import type { TranscriptNative } from './transcript-actions.ts';

type ImageRequest = { source: ChatTranscriptSource; part: ChatTranscriptPart; key: string };
type Viewer = ImageRequest & { trigger: HTMLElement };
type ImageContext = {
  native?: TranscriptNative;
  enabled: boolean;
  /** Each image's URL from main, read while a picture of it shows; keyed by `ImageRequest.key`. */
  urls: ((key: string) => Atom.Atom<AsyncResult.AsyncResult<string, unknown>>) | null;
  open(viewer: Viewer): void;
  close(key: string): void;
};
const Images = createContext<ImageContext | null>(null);

function getImageIssue(part: ChatTranscriptPart, native?: TranscriptNative) {
  if (part.kind !== 'image' || part.availability !== 'available')
    return `Stored image is ${part.availability}.`;
  if (!['image/png', 'image/jpeg'].includes(part.mimeType ?? ''))
    return 'Preview supports PNG and JPEG only. This stored type is unsupported.';
  if (part.encoding !== 'base64' || part.bytes <= 0)
    return 'The stored image is corrupt or its bytes do not match its type.';
  if (part.bytes > maximumTranscriptImageBytes)
    return 'Stored image exceeds the 4 MiB preview limit.';
  if (!native) return 'Image preview is unavailable here.';
}

const noUrl = Atom.make(AsyncResult.initial<string, unknown>());
/** Reads each image's URL once per showing; leaving the page interrupts the read. */
const makeImageUrls = (native: TranscriptNative) =>
  Atom.family((key: string) => {
    const { source, part } = JSON.parse(key) as Pick<ImageRequest, 'source' | 'part'>;
    const image: TranscriptImage = {
      source,
      selection: { partId: part.partId, bytes: part.bytes, revision: part.revision },
      mimeType: part.mimeType as TranscriptImage['mimeType'],
    };
    return Atom.make(Effect.tryPromise((signal) => native.imageUrl(image, signal)));
  });

export function StoredImages({
  native,
  enabled,
  fallback,
  onReadingSourceChange,
  children,
}: {
  native?: TranscriptNative;
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
  const urls = useMemo(() => native && makeImageUrls(native), [native]);
  const context = useMemo(
    () => ({ native, enabled, urls: urls ?? null, open, close }),
    [native, enabled, urls, open, close],
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
            {enabled && viewer && <Picture key={viewer.key} request={viewer} thumbnail={false} />}
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
  const { close } = useContext(Images)!;
  const key = JSON.stringify({ source, part });
  const request = useMemo(() => ({ source, part, key }), [source, part, key]);
  useEffect(() => () => close(key), [close, key]);
  return (
    <div data-stored-image {...stylex.props(styles.image)}>
      <p {...stylex.props(styles.meta)}>
        {part.mimeType ?? 'Unknown type'} · {part.bytes.toLocaleString()} bytes
      </p>
      <Picture key={key} request={request} thumbnail />
    </div>
  );
}

/** Main serves the bytes from an opaque, document-scoped URL; Chromium decodes them. */
function Picture({ request, thumbnail }: { request: ImageRequest; thumbnail: boolean }) {
  const { native, enabled, urls, open } = useContext(Images)!;
  const { part } = request;
  const issue = getImageIssue(part, native);
  const atom = enabled && !issue && urls ? urls(request.key) : noUrl;
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  /** The loaded image's size, and a URL Chromium could not decode. */
  const [shown, setShown] = useState<{ url: string; size?: string; broken?: boolean } | null>(null);
  const read = AsyncResult.isSuccess(result) ? result.value : undefined;
  const current = shown?.url === read ? shown : null;
  const failed = (AsyncResult.isFailure(result) && !result.waiting) || !!current?.broken;
  const error =
    issue ?? (failed ? 'Could not load this stored image. Retry the preview.' : undefined);
  const url = enabled && !error ? read : undefined;
  const size = current?.size;
  const ready = !!url && !!size;
  let placeholder = 'Image preview paused';
  if (enabled) placeholder = 'Loading image…';
  if (error) placeholder = 'Preview unavailable';
  const picture = url && (
    <img
      src={url}
      alt={thumbnail ? 'Stored image thumbnail' : 'Recorded image'}
      loading="lazy"
      decoding="async"
      onLoad={({ currentTarget: image }) =>
        setShown({
          url,
          size: `${image.naturalWidth.toLocaleString()} × ${image.naturalHeight.toLocaleString()} pixels`,
        })
      }
      onError={() => setShown({ url, broken: true })}
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
          {!ready && <span {...stylex.props(styles.placeholder)}>{placeholder}</span>}
        </Button>
      ) : (
        <div tabIndex={0} aria-label="Image viewport" {...stylex.props(styles.viewport)}>
          {picture}
        </div>
      )}
      {(ready || thumbnail) && (
        <p aria-hidden={!ready} {...stylex.props(styles.meta, styles.caption)}>
          {ready && size}
          {thumbnail && ready ? ' · Open to inspect' : ''}
        </p>
      )}
      {error && (
        <p role="alert" {...stylex.props(styles.meta)}>
          {error}
        </p>
      )}
      {failed && !issue && enabled && (
        <Button
          {...stylex.props(controls.button)}
          onClick={() => {
            setShown(null);
            retry();
          }}>
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
    display: 'grid',
    placeItems: 'center',
    width: 336,
    maxWidth: '100%',
    height: 196,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  // Fixed box: lazy loading needs a rendered element and decode settles without layout shift.
  thumbnail: {
    gridArea: '1 / 1',
    width: 320,
    maxWidth: '100%',
    height: 180,
    objectFit: 'scale-down',
  },
  placeholder: { gridArea: '1 / 1' },
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
