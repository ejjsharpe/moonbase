# Moonbase desktop

The macOS Electron app. It composes the workbench, the headless application, this profile's workspace recovery store and the chat clients. Files, Git, search, watching and local chat run in the [daemon](../daemon/README.md) over loopback; remote chat runs in the same daemon on an SSH host. Main (`src/main/main.ts`) is the privileged composition root and owns native capabilities; the sandboxed renderer receives browser-safe clients only.

The renderer opens only roots chosen in the native picker, already known, listed by `listWorktrees` for an approved checkout, or adopted by main (`EditorApprovals.adoptCheckout`) for a checkout the daemon made for a chat. Copy Path and Reveal in Finder send main a checkout and relative paths. Main gets the native picker's and the clipboard's paths itself, but a drop's absolute paths come from the renderer (`webUtils` in the preload, sent with `dropImports`), so main passes every import through the daemon's reserved-path check and the daemon refuses what it may not read.

## Main

- Main is one Effect program on one runtime: `src/main/main.ts` runs `desktop-program.ts`. Every Electron listener belongs to the scope that adds it.
- Its Layer graph is the window (`main-window.ts`), its lifecycle (`window-lifecycle.ts`, with the Quit handshake's pure transitions in `window-state.ts`), then `desktop-services.ts` in order: the local daemon, the remote host, the recovery store, the chat targets, the IPC server and its documents, the `moonbase:` protocol, the connect handler and the menu.
- Quit waits for document releases under way and closes the services backwards. If anything failed to release, it shows the cleanup dialog and exits with code 1.
- Each renderer document has its own scope: its RPC server, requests and watches, captured imports, provider sign-ins and transcript image URLs. A reload or crash closes it and releases what it held.

## IPC

- The one preload (`src/preload/preload.ts`) exposes only `window.moonbase`: `connect(nonce)`, which asks main for a `MessagePort` on `moonbase:connect`/`moonbase:port`, and `pathForFile` for a dropped file. Main hands ports only to the window's main frame showing the app's document.
- Everything else is Effect RPC over the port. The groups in `src/ipc/` (`EditorRpcs`, `DesktopChatRpcs`, `WindowRpcs`) are served by `src/main/ipc/` and called by the renderer's `DesktopIpc` (`src/renderer/ipc/`).
- Main decodes each request once with its procedure's exact schema (an undeclared field is refused); the renderer decodes each reply once.
- `src/ipc/ipc-limits.ts` holds every bound: messages up to 64 Mi UTF-16 units (longer closes the port), 8 ports per document, 128 editor and 64 chat requests (and as many watches) at once, each refused as busy past its limit rather than queued.
- Each procedure declares its errors (`src/ipc/ipc-errors.ts`), which cross as their tags and fields. A handler defect crosses as `IpcFailedError`; in the renderer a closed port is `IpcClosedError` and an undecodable reply `IpcReplyError`.

## Renderer

- The renderer has one runtime (`src/renderer/main.tsx`) over `makeIpcLayer` (`DesktopIpc` and the `WorkspaceService` over it). The editor and application (`makeDocumentLayer` in `src/renderer/renderer-layer.ts`) are built in a document scope on that runtime.
- Views read the editor and application through their atoms (`@effect/atom-react`) and run their actions on that runtime. Chat views read the open chat's atoms (`getChatAtoms`), shared through `src/renderer/chat/chat-context.ts`, and each part reads only the atoms it shows.
- The shell (`src/renderer/shell/`) composes the title bar, the rail and the project dock; `src/renderer/chat/chat-view.tsx` composes the chat list, header, pending commands, transcript and composer. Slash commands are in `src/renderer/chat/composer/commands.ts`.

## Run

From the repository root, on macOS with Xcode command-line tools:

```sh
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
NX_DAEMON=false bunx nx run @moonbase/desktop:dev
```

Development keeps its state in a `Moonbase Dev` profile beside the packaged app's; set `MOONBASE_USER_DATA` to an absolute directory to use another, never one holding data you care about. `bun run dev:mock` uses a `Moonbase Dev Mock` profile whose first launch seeds scripted chats played by a faux model; delete the profile to seed again. `bun run --cwd apps/desktop demo:browser` serves the shell in a browser with faux capabilities: open `/?local&design`, `/?chat&design`, or add `&transcript`.

## Package

```sh
node scripts/prepare-bun.mjs
NX_DAEMON=false bunx nx run @moonbase/desktop:build
bun run --cwd apps/desktop check:renderer
NX_DAEMON=false bunx nx run @moonbase/desktop:package
MOONBASE_USER_DATA="$(mktemp -d -t moonbase-packaged)" \
  apps/desktop/release/mac-arm64/Moonbase.app/Contents/MacOS/Moonbase
```

The app bundles Electron and the [daemon](../daemon/README.md#build-and-package) with its pinned Bun runtime. Only packaging needs `prepare-bun.mjs`. System Git and plutil are required. Packages are unsigned and not notarized.

## Local chat

- Local chat runs in the profile's own daemon, with its data in `<user data>/daemon-v1`; each profile has its own and never shares the packaged app's. Main starts it detached in its own process group (`effect/process` `ChildProcess`), and once it listens it outlives the app.
- A daemon of another build that speaks this protocol is used meanwhile and replaced once it has no active work (checked every 30 seconds). One that speaks another protocol is left alone, and requests fail with `LocalDaemonError` `older-daemon` until it exits.
- Every request goes through `LocalDaemon`'s one acquisition (`src/main/daemon/local-daemon.ts`): one attempt at a time, which later requests join, and whose failure answers them all for 2 seconds. A crashed or idle-exited daemon is started again on the next request.
- **Moonbase › Restart Daemon…** stops this profile's daemon (`SIGTERM`) and starts this app's. A development daemon always reports build `development`, so restart it after changing daemon source.
- The token and endpoint stay in main. Chat travels over one RPC WebSocket and files over a separate workspace socket, so a large file never delays chat. Main's recovery store (`<user data>/workspace-v1`) keeps drafts and editor state.
- A local chat may use only a folder the daemon approved: one chosen in the native picker, the root of a checkout the editor opened, or a worktree the daemon made for it. The daemon re-checks each folder's identity on use. **The working folder is context, not a sandbox**: tools run with your OS permissions.
- Provider credentials stay in the daemon, encrypted under a key in the Keychain; they never reach main or the renderer.
- Quit does not stop local agents: they keep running in the daemon. Unsaved editor work still asks first, and the document's answer to `quit` can decline it (`src/main/window-state.ts`). A new chat's worktree and Turn into project are made under request ids kept until the outcome is known, so a repeat after a lost reply never makes a second one.

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

The host runs the [daemon in host mode](../daemon/README.md#remote-host): `remotePort` is its `port`, `expected` and `actorId` come from its `identity.json`, and `token` is its `token` file. Copy the token without it ever being a command's argument:

```sh
ssh my-host 'cat ~/MoonbaseHost/data/token' | node -e '
  const fs = require("node:fs"), file = process.argv[1];
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.token = fs.readFileSync(0, "utf8").trim();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
' /absolute/private/remote-chat.json
```

- An optional absolute `sshExecutable` overrides `/usr/bin/ssh`. Configure SSH as the [SSH package](../../packages/ssh/README.md) describes, then Connect from the chats sidebar or **Settings › Hosts**.
- Remote chat uses the same chat, folder and provider clients as local chat, each only when the host's signed health advertises it. Its folder menu lists the host's approved roots; editor projects and worktrees are local only.
- Remote drafts are kept under one key (`moonbase.chat.remote.v2`), so changing the host blocks sends until they are cleared.
- The renderer never receives the endpoint or token, and a remote host's paths never grant access to local files.

## Transcript

- The transcript is a [Legend List](https://legendapp.com/open-source/list/), which owns scrolling, virtualization, following the end and holding position.
- Rows are keyed `entry:<id>` and `live:<submissionId>`; consecutive activity rows draw as one card that keeps its key as rows join it.
- A saved reading position is a stored row and an offset below its top, held on restore until the reader's first input.
- Each row reads its own atoms (`makeTranscriptAtoms`), so an unchanged row never re-renders; the view's own atoms are in `transcript-view.ts`, saved with `updateTranscriptView`.
- `src/renderer/chat/transcript/` is grouped by what each part draws: `list/`, `row/`, `activity/`, `part/`, `disclosure/` and `markdown/`.

## Transcript images

- Main serves stored PNG/JPEG images from `moonbase://editor/transcript-image/<token>`. The token is random, holds no path, expires after 10 minutes unrequested and is revoked when its document is released.
- Up to 6 reads run at once and 64 more queue; a source over 4 MiB is refused (413), as are bytes that don't match their declared type (415).
- The CSP is unchanged: the renderer uses a plain `<img>`, and Markdown images stay links.

## Checks

```sh
bun run --cwd apps/desktop typecheck
bun run --cwd apps/desktop lint
bun run --cwd apps/desktop test
bun run --cwd apps/desktop test:browser
bun run --cwd apps/desktop test:native
bun run --cwd apps/desktop check:package
bun run --cwd apps/desktop test:package
```

- Build before native tests and package before package tests. `test:native` runs the Electron specs from source (pass a spec file or `--grep`); `test:package` runs the packaged daemon smoke test, the Playwright `packaged` project and the `native` specs tagged `@packaged` against the package.
- `test:linux` leaves out `test/macos/`, which `test:macos` runs.
- Native tests start the daemon's faux entry (`apps/daemon/test/faux-daemon.ts`) with the Bun `MOONBASE_TEST_BUN` names or the one on PATH, in temporary user data and repositories, and stop every daemon they left.
- `test:browser` runs the browser demo in Chromium without Electron; set `MOONBASE_BROWSER_PORT` to isolate concurrent runs (default 4177).
- `check:package` compares the shipped daemon files byte for byte with the built `dist`, checks the Bun executable against its pinned SHA-256 and checks the notices carry every pinned Bun notice. Tests inject clipboard and file-opening capabilities.
