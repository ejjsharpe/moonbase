import { Effect, ManagedRuntime } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/services';
import { WorkspaceLocalLive } from '../src/index.ts';
const [root, dataDirectory, file] = process.argv.slice(2);
if (!root || !dataDirectory || !file)
  throw Error(
    'Usage: node --experimental-strip-types packages/workspace/examples/local.ts ABSOLUTE_CHECKOUT ABSOLUTE_FRESH_MOONBASE_STATE RELATIVE_FILE',
  );
const runtime = ManagedRuntime.make(
  WorkspaceLocalLive({
    dataDirectory,
    hostId: 'local-example',
    installationId: 'local-example',
    ...(process.env.MOONBASE_RIPGREP ? { ripgrepExecutable: process.env.MOONBASE_RIPGREP } : {}),
  }),
);
try {
  console.log(
    await runtime.runPromise(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        const checkout = yield* workspace.openCheckout({ root });
        return {
          checkout,
          document: yield* workspace.readFile({ checkout, path: file }),
          git: yield* workspace.gitStatus({ checkout }),
        };
      }),
    ),
  );
} finally {
  await runtime.dispose();
}
