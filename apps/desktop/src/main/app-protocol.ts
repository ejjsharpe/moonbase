import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Net, Protocol } from 'electron';
import { Effect, FiberSet } from 'effect';
import {
  respondTranscriptImage,
  transcriptImagePath,
  type TranscriptImageReader,
} from './chat/transcript-native.ts';

/** The renderer's Content Security Policy, which every `moonbase:` response carries. */
export const appCsp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

/**
 * Serves `moonbase://editor/` while the scope is open: the renderer's files from `rendererRoot`,
 * and the current document's transcript images. Each request runs until it is answered or the
 * renderer drops it.
 */
export const serveAppProtocol = ({
  protocol,
  net,
  rendererRoot,
  findImages,
}: {
  protocol: Pick<Protocol, 'handle' | 'unhandle'>;
  net: Pick<Net, 'fetch'>;
  rendererRoot: string;
  /** The current document's image lookup. */
  readonly findImages: Effect.Effect<(token: string) => TranscriptImageReader | undefined>;
}) =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntimePromise();
    const respond = (request: Request) =>
      Effect.gen(function* () {
        const url = new URL(request.url);
        if (url.pathname.startsWith(transcriptImagePath))
          return yield* respondTranscriptImage(request, appCsp, yield* findImages);
        // Asset cache-busting queries do not grant document/IPC authority.
        const path = resolve(rendererRoot, '.' + decodeURIComponent(url.pathname));
        if (
          url.host !== 'editor' ||
          url.hash ||
          (path !== rendererRoot && !path.startsWith(rendererRoot + sep))
        )
          return new Response('Forbidden', { status: 403 });
        const response = yield* Effect.tryPromise(() => net.fetch(pathToFileURL(path).href));
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', appCsp);
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(response.body, { status: response.status, headers });
      }).pipe(Effect.orElseSucceed(() => new Response('Not found', { status: 404 })));
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        protocol.handle('moonbase', (request) => run(respond(request), { signal: request.signal })),
      ),
      () => Effect.sync(() => protocol.unhandle('moonbase')),
    );
  });
