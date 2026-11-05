import type { ChatController } from '@moonbase/application/chat';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';

export const imageLimits = {
  sourceBytes: 4 * 1024 * 1024,
  imagePixels: 4 * 1024 * 1024,
  dimension: 8192,
  retainedBytes: 20 * 1024 * 1024,
  retainedPixels: 16 * 1024 * 1024,
  concurrent: 2,
  thumbnailWidth: 320,
  thumbnailHeight: 180,
};
const corrupt = () => new Error('The stored image is corrupt or its bytes do not match its type.');
const busy = () =>
  new Error('Image resources are busy. Close another image or scroll, then retry.');

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ (byte & 1 ? 0xedb88320 : 0);
  return byte >>> 0;
});

/** Private view reservations include pending IO/decode until it actually settles. No work queue. */
export class ImageResources {
  private bytes = 0;
  private pixels = 0;
  private work = 0;
  reserve(bytes = 0, pixels = 0, work = 0) {
    if (
      this.bytes + bytes > imageLimits.retainedBytes ||
      this.pixels + pixels > imageLimits.retainedPixels ||
      this.work + work > imageLimits.concurrent
    )
      throw busy();
    this.bytes += bytes;
    this.pixels += pixels;
    this.work += work;
    let alive = true;
    return {
      shrinkPixels: (next: number) => {
        if (!alive || next < 0 || next > pixels) throw Error('Invalid image reservation.');
        this.pixels -= pixels - next;
        pixels = next;
      },
      release: () => {
        if (!alive) return;
        alive = false;
        this.bytes -= bytes;
        this.pixels -= pixels;
        this.work -= work;
      },
    };
  }
}

export function checkImagePart(part: ChatTranscriptPart) {
  if (part.kind !== 'image' || part.availability !== 'available')
    throw Error(`Stored image is ${part.availability}.`);
  if (!['image/png', 'image/jpeg'].includes(part.mimeType ?? ''))
    throw Error('Preview supports PNG and JPEG only. This stored type is unsupported.');
  if (part.encoding !== 'base64') throw corrupt();
  if (!Number.isSafeInteger(part.bytes) || part.bytes <= 0) throw corrupt();
  if (part.bytes > imageLimits.sourceBytes)
    throw Error('Stored image exceeds the 4 MiB preview limit.');
}

function checkDimensions(width: number, height: number) {
  if (!width || !height) throw corrupt();
  if (
    width > imageLimits.dimension ||
    height > imageLimits.dimension ||
    width * height > imageLimits.imagePixels
  )
    throw Error('Stored image exceeds the 4 megapixel or 8,192 pixel side limit.');
  return { width, height };
}

/** Checks containers/dimensions before invoking a decoder; decoding still checks pixel validity. */
export function inspectStoredImage(bytes: Uint8Array, mime: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png') {
    if (
      bytes.length < 45 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    )
      throw corrupt();
    let dimensions: { width: number; height: number } | undefined;
    let data = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset),
        type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
        end = offset + 12 + length;
      if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type)) throw corrupt();
      if (['acTL', 'fcTL', 'fdAT'].includes(type))
        throw Error('Animated PNG previews are unsupported.');
      let crc = 0xffffffff;
      for (let index = offset + 4; index < end - 4; index++)
        crc = crcTable[(crc ^ bytes[index]!) & 255]! ^ (crc >>> 8);
      if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(end - 4)) throw corrupt();
      if (offset === 8 && type !== 'IHDR') throw corrupt();
      if (type === 'IHDR') {
        if (dimensions || offset !== 8 || length !== 13) throw corrupt();
        dimensions = checkDimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
      } else if (type === 'IDAT') data ||= length > 0;
      else if (type === 'IEND') {
        if (length || end !== bytes.length || !dimensions || !data) throw corrupt();
        return dimensions;
      } else if (type[0] === type[0]!.toUpperCase() && type !== 'PLTE') throw corrupt();
      offset = end;
    }
    throw corrupt();
  }
  if (mime !== 'image/jpeg') throw Error('Unsupported stored image type.');
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw corrupt();
  let dimensions: { width: number; height: number } | undefined;
  let scan = false;
  for (let offset = 2; offset < bytes.length;) {
    if (scan) {
      while (offset < bytes.length && bytes[offset] !== 255) offset++;
    }
    if (bytes[offset++] !== 255) throw corrupt();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (scan && (marker === 0 || (marker! >= 208 && marker! <= 215))) continue;
    if (marker === 217) {
      if (!scan || !dimensions || offset !== bytes.length) throw corrupt();
      return dimensions;
    }
    if (marker === undefined || offset + 2 > bytes.length) throw corrupt();
    const length = view.getUint16(offset),
      end = offset + length;
    if (length < 2 || end > bytes.length) throw corrupt();
    if (marker === 192 || marker === 194) {
      if (dimensions || scan || length < 11) throw corrupt();
      if (bytes[offset + 2] !== 8) throw Error('Only 8-bit JPEG previews are supported.');
      const components = bytes[offset + 7]!;
      if (length !== 8 + 3 * components) throw corrupt();
      if (![1, 3, 4].includes(components)) throw Error('This JPEG color layout is unsupported.');
      dimensions = checkDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
    } else if (marker === 218) {
      if (!dimensions || length < 6) throw corrupt();
      scan = true;
    } else if (
      [193, 195, 197, 198, 199, 201, 202, 203, 204, 205, 206, 207, 220, 222, 223].includes(marker)
    )
      throw Error(
        'This JPEG variant is unsupported. Preview supports baseline and progressive JPEG.',
      );
    else if (![196, 219, 221, 254].includes(marker) && !(marker >= 224 && marker <= 239))
      throw corrupt(); // Includes alternate frames, DNL and hierarchical/arithmetic JPEG.
    offset = end;
  }
  throw corrupt();
}

export async function readStoredImage(
  controller: Pick<ChatController, 'iterateTranscript'>,
  source: ChatTranscriptSource,
  part: ChatTranscriptPart,
  resources: ImageResources,
  signal: AbortSignal,
) {
  checkImagePart(part);
  signal.throwIfAborted();
  // Raw bytes + decoder Blob copy + a bounded independently padded transport chunk/string.
  const retained = resources.reserve(2 * part.bytes + 128 * 1024);
  let work: ReturnType<ImageResources['reserve']> | undefined;
  try {
    work = resources.reserve(0, 0, 1);
    const bytes = new Uint8Array(part.bytes);
    let offset = 0;
    const selection = { partId: part.partId, bytes: part.bytes, revision: part.revision };
    for await (const chunk of controller.iterateTranscript(source, { selection, signal })) {
      signal.throwIfAborted();
      if (
        chunk.encoding !== 'base64' ||
        chunk.offset !== offset ||
        JSON.stringify(chunk.source) !== JSON.stringify(source) ||
        chunk.selection.partId !== selection.partId ||
        chunk.selection.bytes !== selection.bytes ||
        chunk.selection.revision !== selection.revision ||
        chunk.data.length > 44 * 1024 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
      )
        throw corrupt();
      const decoded = atob(chunk.data);
      if (!decoded.length || btoa(decoded) !== chunk.data || offset + decoded.length > bytes.length)
        throw corrupt();
      for (let index = 0; index < decoded.length; index++)
        bytes[offset++] = decoded.charCodeAt(index);
    }
    signal.throwIfAborted();
    if (offset !== bytes.length) throw corrupt();
    return {
      bytes,
      mime: part.mimeType!,
      ...inspectStoredImage(bytes, part.mimeType!),
      release: retained.release,
    };
  } catch (error) {
    retained.release();
    throw error;
  } finally {
    work?.release();
  }
}
export type StoredImage = Awaited<ReturnType<typeof readStoredImage>>;
const canvasOwners = new WeakMap<HTMLCanvasElement, object>();

export async function paintStoredImage(
  image: StoredImage,
  resources: ImageResources,
  signal: AbortSignal,
  canvas: HTMLCanvasElement,
  thumbnail: boolean,
  decode: (blob: Blob) => Promise<ImageBitmap> = createImageBitmap,
) {
  signal.throwIfAborted();
  const pixels = resources.reserve(0, 2 * image.width * image.height);
  const owner = {};
  const release = () => {
    if (canvasOwners.get(canvas) === owner) {
      canvasOwners.delete(canvas);
      canvas.width = canvas.height = 0;
    }
    pixels.release();
  };
  let work: ReturnType<ImageResources['reserve']> | undefined;
  let bitmap: ImageBitmap | undefined;
  try {
    work = resources.reserve(0, 0, 1);
    bitmap = await decode(new Blob([image.bytes], { type: image.mime }));
    signal.throwIfAborted();
    checkDimensions(bitmap.width, bitmap.height);
    // JPEG orientation can swap the encoded dimensions; it cannot change their area.
    if (
      !(
        (bitmap.width === image.width && bitmap.height === image.height) ||
        (image.mime === 'image/jpeg' &&
          bitmap.width === image.height &&
          bitmap.height === image.width)
      )
    )
      throw corrupt();
    const scale = thumbnail
      ? Math.min(
          1,
          imageLimits.thumbnailWidth / bitmap.width,
          imageLimits.thumbnailHeight / bitmap.height,
        )
      : 1;
    canvasOwners.set(canvas, owner);
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
    canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw Error('Image drawing is unavailable.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    bitmap = undefined;
    pixels.shrinkPixels(canvas.width * canvas.height);
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    bitmap?.close();
    work?.release();
  }
}
