import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import type { ChatController, TranscriptChunk } from '@moonbase/application/chat';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';
import {
  ImageResources,
  checkImagePart,
  imageLimits,
  inspectStoredImage,
  paintStoredImage,
  readStoredImage,
} from '../src/renderer/chat/stored-image.ts';

const png = new Uint8Array(
  await readFile(new URL('./fixtures/images/retained.png', import.meta.url)),
);
const jpeg = new Uint8Array(
  await readFile(new URL('./fixtures/images/retained.jpg', import.meta.url)),
);
const source: ChatTranscriptSource = {
  kind: 'entry',
  target: { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor', conversationId: 'one' },
  entryId: 'record',
};
const part: ChatTranscriptPart = {
  partId: 'm0.b0',
  kind: 'image',
  role: 'tool',
  availability: 'available',
  encoding: 'base64',
  bytes: png.length,
  revision: 'a'.repeat(64),
  mimeType: 'image/png',
  text: '',
  truncated: false,
};
function reader(bytes = png, change: (chunk: TranscriptChunk) => void = () => {}) {
  return {
    async *iterateTranscript(received, options) {
      assert.deepEqual(received, source);
      assert.deepEqual(options!.selection, {
        partId: part.partId,
        bytes: bytes.length,
        revision: part.revision,
      });
      for (let offset = 0; offset < bytes.length; offset += 16000) {
        const chunk = {
          source,
          selection: options!.selection!,
          offset,
          encoding: 'base64' as const,
          data: Buffer.from(bytes.subarray(offset, offset + 16000)).toString('base64'),
        };
        change(chunk);
        yield chunk;
      }
    },
  } satisfies Pick<ChatController, 'iterateTranscript'>;
}
test('real PNG and JPEG dimensions; HTML/SVG, mismatched MIME, truncated and alternate frames reject before decoding', () => {
  assert.deepEqual(inspectStoredImage(png, 'image/png'), { width: 192, height: 128 });
  assert.deepEqual(inspectStoredImage(jpeg, 'image/jpeg'), { width: 256, height: 128 });
  const precision = jpeg.slice(),
    frame = precision.findIndex(
      (byte, index) => byte === 255 && [192, 194].includes(precision[index + 1]!),
    );
  assert(frame > 0);
  precision[frame + 4] = 12;
  assert.throws(() => inspectStoredImage(precision, 'image/jpeg'), /8-bit JPEG/);
  for (const [bytes, mime] of [
    [png, 'image/jpeg'],
    [jpeg, 'image/png'],
    [Buffer.from('<html><img src="https://evil.test"></html>'), 'image/png'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/png'],
    [png.subarray(0, 32), 'image/png'],
    [png.subarray(0, -1), 'image/png'],
    [jpeg.subarray(0, -2), 'image/jpeg'],
    [new Uint8Array([...jpeg, ...jpeg]), 'image/jpeg'],
  ] as const)
    assert.throws(() => inspectStoredImage(bytes, mime), /corrupt/);
  const animated = png.slice();
  animated.set(new TextEncoder().encode('acTL'), 37);
  assert.throws(() => inspectStoredImage(animated, 'image/png'), /Animated PNG/);
  const crc = png.slice();
  crc[29] ^= 1;
  assert.throws(() => inspectStoredImage(crc, 'image/png'), /corrupt/);
  const length = png.slice();
  new DataView(length.buffer).setUint32(33, 0xffffffff);
  assert.throws(() => inspectStoredImage(length, 'image/png'), /corrupt/);
});
test('zero, huge sides and decoded pixel overflow are rejected from the container header', () => {
  for (const [width, height] of [
    [0, 1],
    [1, 0],
    [8193, 1],
    [2049, 2048],
    [0xffffffff, 0xffffffff],
  ]) {
    const bytes = png.slice();
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    view.setUint32(29, crc32(bytes.subarray(12, 29)));
    assert.throws(() => inspectStoredImage(bytes, 'image/png'), /corrupt|limit/);
  }
  for (const change of [
    { mimeType: 'image/svg+xml' },
    { mimeType: 'text/html' },
    { availability: 'unavailable' as const },
    { bytes: imageLimits.sourceBytes + 1 },
    { bytes: 0 },
    { encoding: 'utf8' as const },
  ])
    assert.throws(() => checkImagePart({ ...part, ...change }));
});
test('fixed record chunks are independently padded and reconstruct every byte, with explicit completion and canonical encoding', async () => {
  const resources = new ImageResources(),
    signal = new AbortController().signal;
  const image = await readStoredImage(reader(), source, part, resources, signal);
  assert.deepEqual(image.bytes, png);
  image.release();
  image.release();
  for (const change of [
    (chunk: TranscriptChunk) => {
      chunk.encoding = 'utf8';
    },
    (chunk: TranscriptChunk) => {
      chunk.offset++;
    },
    (chunk: TranscriptChunk) => {
      chunk.source = { ...source, entryId: 'another' };
    },
    (chunk: TranscriptChunk) => {
      chunk.selection = { ...chunk.selection, revision: 'b'.repeat(64) };
    },
    (chunk: TranscriptChunk) => {
      chunk.data += '\n';
    },
    (chunk: TranscriptChunk) => {
      chunk.data = 'Zh==';
    },
    (chunk: TranscriptChunk) => {
      chunk.data = '';
    },
  ])
    await assert.rejects(readStoredImage(reader(png, change), source, part, resources, signal));
  const incomplete: Pick<ChatController, 'iterateTranscript'> = { async *iterateTranscript() {} };
  await assert.rejects(readStoredImage(incomplete, source, part, resources, signal), /corrupt/);
  const again = await readStoredImage(reader(), source, part, resources, signal);
  again.release();
});
test('aggregate retention, decode pixels and concurrency are reserved before work; cleanup is idempotent', () => {
  const resources = new ImageResources();
  const bytes = resources.reserve(imageLimits.retainedBytes);
  assert.throws(() => resources.reserve(1), /busy/);
  bytes.release();
  bytes.release();
  const pixels = resources.reserve(0, imageLimits.retainedPixels);
  assert.throws(() => resources.reserve(0, 1), /busy/);
  pixels.shrinkPixels(1);
  resources.reserve(0, imageLimits.retainedPixels - 1).release();
  pixels.release();
  const work = resources.reserve(0, 0, 2);
  assert.throws(() => resources.reserve(0, 0, 1), /busy/);
  work.release();
  resources.reserve(imageLimits.retainedBytes, imageLimits.retainedPixels, 2).release();
});
test('abort retains actual read/decode ownership until held completion and closes late bitmaps without painting', async () => {
  const resources = new ImageResources(),
    job = new AbortController();
  let release = () => {},
    entered = () => {},
    finalized = false;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held: Pick<ChatController, 'iterateTranscript'> = {
    async *iterateTranscript() {
      try {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { source, selection: part, offset: 0, encoding: 'base64', data: 'aQ==' };
      } finally {
        finalized = true;
      }
    },
  };
  const pending = readStoredImage(held, source, part, resources, job.signal);
  await started;
  job.abort();
  assert.equal(finalized, false);
  assert.throws(() => resources.reserve(0, 0, 2), /busy/);
  release();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(finalized, true);
  let closed = 0,
    painted = 0;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {
        painted++;
      },
    }),
  } as unknown as HTMLCanvasElement;
  const image = await readStoredImage(
    reader(),
    source,
    part,
    resources,
    new AbortController().signal,
  );
  const decodeJob = new AbortController();
  let finish = (_bitmap: ImageBitmap) => {};
  const decoding = paintStoredImage(
    image,
    resources,
    decodeJob.signal,
    canvas,
    true,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  decodeJob.abort();
  assert.throws(() => resources.reserve(0, imageLimits.retainedPixels), /busy/);
  finish({
    width: 192,
    height: 128,
    close: () => {
      closed++;
    },
  } as ImageBitmap);
  await assert.rejects(decoding, { name: 'AbortError' });
  assert.equal(closed, 1);
  assert.equal(painted, 0);
  assert.equal(canvas.width, 0);
  image.release();
  resources.reserve(imageLimits.retainedBytes, imageLimits.retainedPixels, 2).release();
});
test('decoded dimensions are rechecked; successful canvas and failed decoder release every reservation', async () => {
  const resources = new ImageResources(),
    signal = new AbortController().signal;
  const image = await readStoredImage(reader(), source, part, resources, signal);
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
  } as unknown as HTMLCanvasElement;
  let closed = 0;
  for (const [width, height] of [
    [2, 2],
    [100000, 100000],
  ]) {
    await assert.rejects(
      paintStoredImage(
        image,
        resources,
        signal,
        canvas,
        false,
        async () =>
          ({
            width,
            height,
            close: () => {
              closed++;
            },
          }) as ImageBitmap,
      ),
    );
  }
  assert.equal(closed, 2);
  await assert.rejects(
    paintStoredImage(image, resources, signal, canvas, false, async () => {
      throw Error('decode failed');
    }),
    /decode failed/,
  );
  const release = await paintStoredImage(
    image,
    resources,
    signal,
    canvas,
    true,
    async () =>
      ({
        width: image.width,
        height: image.height,
        close: () => {
          closed++;
        },
      }) as ImageBitmap,
  );
  assert.equal(closed, 3);
  assert.equal(canvas.width, 192);
  release();
  release();
  assert.equal(canvas.width, 0);
  image.release();
  resources.reserve(imageLimits.retainedBytes, imageLimits.retainedPixels, 2).release();
});

test('late cancelled decode and old cleanup cannot erase a newer canvas owner', async () => {
  const resources = new ImageResources(),
    signal = new AbortController().signal;
  const image = await readStoredImage(reader(), source, part, resources, signal);
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
  } as unknown as HTMLCanvasElement;
  let closed = 0;
  const bitmap = () =>
    ({
      width: image.width,
      height: image.height,
      close: () => {
        closed++;
      },
    }) as ImageBitmap;
  const job = new AbortController();
  const held = Promise.withResolvers<ImageBitmap>();
  const old = paintStoredImage(image, resources, job.signal, canvas, true, () => held.promise);
  job.abort();
  const release = await paintStoredImage(image, resources, signal, canvas, true, async () =>
    bitmap(),
  );
  held.resolve(bitmap());
  await assert.rejects(old, { name: 'AbortError' });
  assert.equal(canvas.width, 192);
  assert.equal(canvas.height, 128);
  assert.equal(closed, 2);
  const newest = await paintStoredImage(image, resources, signal, canvas, true, async () =>
    bitmap(),
  );
  release();
  assert.equal(canvas.width, 192);
  assert.equal(canvas.height, 128);
  newest();
  assert.equal(canvas.width, 0);
  assert.equal(closed, 3);
  image.release();
  resources.reserve(imageLimits.retainedBytes, imageLimits.retainedPixels, 2).release();
});
