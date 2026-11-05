# Stored transcript images

Desktop's private `renderer/chat/stored-image.ts` and `.tsx` consume the supplied controller's complete-content iterator. They add no contract metadata, Pi normalization, runtime acquisition, saved state or native authority. Controller iteration completion and cancelled rejection join that iterator's own admitted raw data/proof IO, so the image resource budget cannot be released by an abort race while that IO is still alive. A visible MIME/descriptor never authorizes a path or URL. Markdown images remain explicit links, and transcript images never fetch network/file URLs.

A disclosed image in the visible transcript reads its exact source and fixed `{partId, bytes, revision}`. The controller retains schema, echo, cursor/progress/completion, current-selection, generation and lifecycle checks, including actual IO settlement on cancellation. The image consumer additionally checks encoding/echoes/offsets/complete byte count and canonical base64. Each independently padded chunk is decoded separately into one bounded byte array. It never joins encoded strings or relies on the hydration LRU retaining a complete image.

## Validation and presentation

Static PNG and 8-bit baseline/progressive JPEG are supported. PNG signature, chunk bounds/types, CRCs, required header/data/end and positive dimensions are checked before decode; animated PNG is explicitly unsupported. JPEG parsing checks marker/segment bounds, a single supported frame, dimensions, scans and terminal end, rejecting deferred height, alternate frames and unsupported variants. MIME must agree with the actual raster container. Image parts always enter this policy, including malformed descriptors claiming UTF-8; they cannot fall through to generic text hydration/Copy. Unknown MIME, SVG/HTML, missing/unavailable, corrupt/truncated and oversized content receive visible metadata/errors. Nothing is inserted as authored HTML.

The container rules follow the [W3C PNG specification](https://www.w3.org/TR/png/) and [ITU-T T.81 JPEG specification](https://www.w3.org/Graphics/JPEG/itu-t81.pdf). These checks bound dimensions before invoking the platform decoder. `createImageBitmap(Blob)` must then succeed, and its dimensions must match the validated header (JPEG orientation may swap width/height). The [HTML ImageBitmap API](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html) supplies decode and explicit bitmap close. Failed pixel decoding remains observable and retryable.

Images draw into canvases; no object URLs or `<img>` resources are created. Production `moonbase://editor/index.html` retains its existing CSP, including `img-src 'self' data:` and every script/frame/connect/navigation/permission rule. There is no Blob CSP expansion. Thumbnails use a fixed 336 × 196 control frame and at most 320 × 180 pixels, with caption space reserved before decode. The existing per-view ResizeObserver/Part anchor handles settled metadata and layout changes; image overflow stays contained.

One Base UI dialog per transcript provides a title/description, labelled Close, focus trap, Escape and focus return to the original visible trigger. At 128 rows, its exact source privately pins the oldest row while portal focus is outside that row. This pin survives closing until actual focus returns, when the transcript's existing row focus tracking takes over; leaving the trigger releases it normally. If navigation actually removes its record, it closes and falls back to the visible transcript region. Opening rereads/revalidates the exact fixed selection through the same controller; it grants no new authority. There are no attachment, clipboard, save/download, export or OCR actions. Image interaction cancels Find reveal like other reading input.

## Scoped resource limits

| Resource | Bound |
| --- | --- |
| One source | 4 MiB |
| One decoded image | 4,194,304 pixels; neither side over 8,192 |
| View's encoded reservations | 20 MiB, including source array + decoder Blob copy + 128 KiB chunk/string allowance per read |
| View's managed decoded reservations | 16,777,216 pixels, including simultaneous full decode/canvas allocation before shrinking to retained canvas size |
| Concurrent view work | Two reads/decodes; no background queue |
| Retained thumbnail | At most 320 × 180 pixels; source bytes released after drawing |

DesktopShell owns the reservations across conversation, target and Chat panel replacement, so pending old work cannot obtain a fresh budget by replacing the view. These bound managed resources rather than every browser decoder/GPU allocation. A full-budget image can temporarily prevent another decode; the visible busy state offers Retry after other work releases. There is no additional cache/store/scheduler. Stop and unrelated controller actions retain their existing independent paths.

Bitmap handles close immediately after drawing, and on failed/cancelled/late decode. Clearing an owned canvas sets both dimensions to zero and releases its pixel reservation idempotently. A weak per-canvas owner token prevents an old cancelled decode/cleanup from clearing a canvas repainted by a newer visibility session. Source arrays/Blob copies remain reserved until actual read/decode settlement; cancellation cannot free capacity early while ignored-abort IO or a platform decode is still pending.

IntersectionObserver cancels and clears offscreen content. A private `ImageVisibility` context explicitly propagates Activity collapse because Activity retains children under `hidden`; unmount alone is insufficient. Part collapse, row/descriptor eviction, source/target/controller changes, offline/hidden view and disposal fence late publication and release presentation resources. The existing controller owns and awaits actual read cleanup even after panel removal. Pending platform decode is fenced and its eventual bitmap closes without publication.

## Fixtures and tests

`test/fixtures/images/retained.png` is deterministic RGB noise (192 × 128, Python standard-library zlib, seed 113), large enough for multiple independently padded production chunks. `checker.png` is a generated two-color 256 × 128 checker, `retained.jpg` is its `sips` JPEG conversion, and `tall.png` is a 128 × 1,024 checker for thumbnail scaling and independent viewer overflow. These are controlled test pixels, not design assets.

`stored-image.test.ts` exercises container/MIME/CRC/dimensions, malformed echoes/encoding/completion, aggregate reservations, held actual read/decode settlement, late close and decoder/canvas release. `stored-image-runtime.test.ts` uses real LocalPi SQLite plus a separately authenticated child host/forwarder, exact record/actor/store isolation, reconstruction, missing selections and corrupt stored fixtures. `stored-image.spec.ts` and the focused `local-chat.spec.ts` cases cover browser/native presentation, including pointer Part/Activity disclosure, Find interaction and the oldest-row viewer pin. Clipboard capabilities remain injected; these tests perform no OS clipboard IO.

Native fixture teardown always attempts both app and host cleanup through nested `finally` blocks and waits up to fifteen seconds to observe actual child exit; no timeout declares cleanup successful. Packaged execution, manual/VoiceOver accessibility, real providers/SSH and physical performance are outside these suites.
