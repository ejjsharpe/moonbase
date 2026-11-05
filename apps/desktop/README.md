# Moonbase desktop

The macOS Electron app. It composes the workbench, headless application, workspace, local Pi and optional SSH/remote Pi modules. `src/main.ts` is the privileged composition root and owns native capabilities; the sandboxed renderer receives browser-safe clients only.

## Run

From the repository root, on macOS with Xcode command-line tools:

```sh
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
NX_DAEMON=false bunx nx run @moonbase/desktop:dev
```

`bun dev` in `apps/desktop` does the same build-then-launch. Each development launch uses a fresh temporary user-data directory; set `MOONBASE_USER_DATA` to an absolute directory to reuse state. Never point it at real application data you care about. Rebuild and relaunch after changes.

`bun run --cwd apps/desktop demo:browser` serves the shell in a browser with in-memory and faux capabilities, calling no real provider or host. Open `/?local&design` for local chat, `/?chat&design` for the remote fixture, or add `&transcript` for transcript reading fixtures.

## Package

```sh
NX_DAEMON=false bunx nx run @moonbase/desktop:build
bun run --cwd apps/desktop check:renderer
NX_DAEMON=false bunx nx run @moonbase/desktop:package
MOONBASE_USER_DATA="$(mktemp -d -t moonbase-packaged)" \
  apps/desktop/release/mac-arm64/Moonbase.app/Contents/MacOS/Moonbase
```

The app bundles Electron, the workspace native helper and ripgrep; system Git and plutil are required. Packages are unsigned and not notarized.

## Local chat

Local chat needs no configuration: choose a provider under **Provider setup**, then a working folder and model. Credentials are encrypted with Electron safeStorage (there is no plaintext fallback) and never reach renderer storage or snapshots. Local tools run with your OS permissions: **the working folder is context, not a sandbox**.

## Remote chat

Set `MOONBASE_CHAT_CONFIG` to an absolute private JSON file outside source control (mode `0600`, owned by you, not a symlink):

```json
{
  "profile": {
    "id": "personal-host",
    "label": "Personal host",
    "destination": "an-already-authorized-ssh-alias",
    "remotePort": 8787,
    "expected": { "hostId": "my-host", "storeId": "my-store" }
  },
  "actorId": "personal",
  "token": "YOUR-SEPARATELY-PROVISIONED-PRIVATE-RANDOM-HOST-KEY"
}
```

An optional absolute `sshExecutable` overrides `/usr/bin/ssh`. Start the [Pi host](../../packages/pi-runtime/README.md) on the remote machine and configure SSH as described in the [SSH package](../../packages/ssh/README.md), then Connect in the app. The renderer never receives the endpoint or key, and a remote host's paths never grant access to local files.

## Checks

Build before native tests and package before package tests:

```sh
bun run --cwd apps/desktop typecheck
bun run --cwd apps/desktop lint
bun run --cwd apps/desktop test
bun run --cwd apps/desktop test:browser
bun run --cwd apps/desktop test:local
bun run --cwd apps/desktop test:native
bun run --cwd apps/desktop check:package
bun run --cwd apps/desktop test:package
```

`test:browser` runs the shell in Chromium without Electron; set `MOONBASE_BROWSER_PORT` to isolate concurrent runs (default 4177). `test:native` and `test:package` drive real Electron with temporary repositories and user data. Tests inject clipboard and file-opening capabilities.
