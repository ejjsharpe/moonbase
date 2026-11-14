# Moonbase desktop

The macOS Electron app. It composes the workbench, headless application, this profile's workspace recovery store and the chat clients of Pi. Files, Git, search and watching, and local chat, run in the [daemon](../daemon/README.md), reached over loopback; remote chat runs in the same daemon on an SSH host. `src/main/main.ts` is the privileged composition root and owns native capabilities; the sandboxed renderer receives browser-safe clients only.

The renderer opens only roots chosen in the native picker, already known, listed by `listWorktrees` for an approved checkout, or opened by main with `EditorSession.adoptCheckout`. It cannot call `createWorktree` with a location of its own; a new chat's worktree is made by the daemon at a location it derives (below). Copy Path and Reveal in Finder likewise send main a checkout and relative paths: main writes the clipboard itself and reveals only paths that still resolve inside the checkout once links are followed, and only for checkouts of the local daemon's host (a checkout bound to another host is never shown in Finder). Reveal in Finder and imports are for this Mac's files only. Imports are captured by the local daemon (a host-mode daemon refuses them, and a remote host's paths mean nothing here). Main gets the paths of the native picker and the clipboard's Finder files itself; a drop's paths come from the renderer (`webUtils` in the preload, sent as `dropped-imports`), so main passes every import through the daemon's reserved-path check and the daemon refuses what it may not read. A clipboard import asks for consent only when the clipboard holds Finder files, checking for their type without reading anything, and finds none otherwise, so ⌘V can paste the tree's own entries; a declined prompt returns null, so it pastes nothing.

## Window

A title bar runs across the top: the window controls, back and forward, the sidebar button, then the open file or view's title over the content column, and buttons for project chats (⌘J) and a new chat. Back and forward (⌃- and ⌃⇧-, Alt+← and Alt+→ off macOS, or the mouse's side buttons) step through the places the window has shown: a chat in Agents, or a project and its file. The history lasts as long as the window, up to 50 places; a closed project is passed over, and a chat or file that can no longer open drops out. ⌘B (or ⌃⌘S) hides the main sidebar: the explorer, or the chat list in Agents. The project rail sits under the title bar; ⌃⌥⌘S or the button at its foot hides it, and it then slides over the window while the pointer is at the left edge. Both choices are kept in renderer local storage.

## Run

From the repository root, on macOS with Xcode command-line tools:

```sh
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
NX_DAEMON=false bunx nx run @moonbase/desktop:dev
```

`bun dev` in `apps/desktop` does the same build-then-launch. Development keeps its state between launches in a `Moonbase Dev` profile beside the packaged app's (on macOS, `~/Library/Application Support/Moonbase Dev`); set `MOONBASE_USER_DATA` to an absolute directory to use another. Never point it at real application data you care about. Rebuild and relaunch after changes.

`bun run dev:mock` launches with a separate `Moonbase Dev Mock` profile. Its first launch seeds its daemon's store (`daemon-v1`, before the daemon first starts) with scripted local chats played by a faux model, covering thinking, completed and failed tool steps, an edit and Markdown answers. Their edits touch only a `mock-project` folder inside that profile, and the chat in this repository only reads. Delete the profile to seed again.

`bun run --cwd apps/desktop demo:browser` serves the shell in a browser with in-memory and faux capabilities, calling no real provider or host. Open `/?local&design` for local chat, `/?chat&design` for the remote fixture, or add `&transcript` for transcript reading fixtures.

## Package

```sh
node scripts/prepare-bun.mjs
NX_DAEMON=false bunx nx run @moonbase/desktop:build
bun run --cwd apps/desktop check:renderer
NX_DAEMON=false bunx nx run @moonbase/desktop:package
MOONBASE_USER_DATA="$(mktemp -d -t moonbase-packaged)" \
  apps/desktop/release/mac-arm64/Moonbase.app/Contents/MacOS/Moonbase
```

The app bundles Electron and the [daemon](../daemon/README.md): the pinned Bun runtime in `Contents/Helpers/bun`, `daemon.mjs` with `inert-mcp.mjs` in `Contents/Resources/daemon`, and the workspace native helper and ripgrep in `Contents/Resources/workspace`, which only the daemon uses (about 97.6 MB, 88.7 MB of it Bun and 2.4 MB of it Bun's notices). Only packaging needs `prepare-bun.mjs`; a build bundles the daemon but not its runtime. System Git and plutil are required. Packages are unsigned and not notarized.

## Local chat

Local chat runs in the profile's own daemon, with its data in `<user data>/daemon-v1`; each `MOONBASE_USER_DATA` profile, development's included, has its own daemon and never shares one with the packaged app. Main reads the daemon's `endpoint.json`, `token` and `identity.json` there and checks its signed health for that host and store. If none answers, main starts it detached with no stdio (it logs to `daemon-v1/logs`): the packaged app's bundled Bun and daemon, or in development `bun` from PATH on `apps/daemon/src/main.ts`. A second launch reuses it. A daemon of another build (`endpoint.json`'s `build`: the bundle's SHA-256, embedded in main, or `development` from source) that speaks this protocol is used meanwhile (a development daemon always reports `development`, so after changing daemon source a running one is reused until it idles out; stop it by hand to pick up the change); main asks it every 30 seconds whether it has active work and, once it has none, stops it (`SIGTERM`) and starts its own. One that speaks another protocol is left alone: local chat and files are Unavailable ("An older Moonbase daemon is still finishing its work") and retried on each request until it exits by itself, idle with nobody connected, or the user stops it with **Restart Daemon…** (below). Before each request main checks that process still runs and otherwise starts or finds the daemon again, so a crashed daemon, or one that exited once idle, is back on the next request; an open chat shows **Reconnecting to live updates…** meanwhile. The window opens without waiting for the daemon. If it can't be started or reached, local chat and files are Unavailable until a retry: requests waiting meanwhile share one attempt, a failed attempt is every request's answer for 2 seconds rather than started anew, and a file request stops waiting for the daemon at its own deadline (Unavailable, never sent). Drafts stay in the profile's recovery store, and Quit still keeps them. A daemon without the workspace is replaced by the same 30-second check once it has no work, and **Moonbase › Restart Daemon…** replaces it now after asking: it stops the daemon of this profile (`SIGTERM`), one of an older protocol included once its command line shows it runs on this profile's directory, then starts this app's at once; its runs resume there. A daemon with the same build tag, such as a development one after a source change, is not seen as outdated, so restart it this way. Main reaches the daemon (local, or remote through the SSH forward) over one authenticated WebSocket, which carries requests and pushes chats, the chat list and provider sign-in progress; windows get them over IPC. The token and endpoint stay in main. Files travel over the same socket: main composes the profile's recovery store (`<user data>/workspace-v1`: drafts, editor state, what it sent to the daemon) over the daemon's file host, keyed by a per-profile installation ID kept in that folder.

Local chat needs no configuration: choose a provider in **Settings › Providers** (⌘, or the gear at the foot of the rail; the model menu links there too), then a model and, optionally, a working folder. A chat in Agents starts with **No project**: it runs in a new empty folder the daemon makes under `daemon-v1/chats`, and lists as No project. Moonbase never deletes a chat's folder. **Turn into project** in the chat's header (in the title bar on Agents) is one daemon operation (`turnChatIntoProject`) that opens that folder as a plain-folder project where it is; the chat then lists under it, and **Initialize Git** adds branch and diff controls. A project's docked chat always uses one of the project's folders. **Claude subscription** uses an installed Claude Code CLI signed in with `claude auth login` (and out with `claude auth logout`), and counts against that Claude plan. A local chat may use only a folder the daemon has approved: one chosen in the native picker (which only main grants), the root of a checkout the editor opened, such as the project root in its docked chat, and a new chat's worktree (which the daemon opens as a checkout as it makes it); a worktree Git merely lists is not approved until it is opened; the daemon decides this itself and re-checks each folder's identity on use, so main grants nothing for editor folders. A path the renderer names grants nothing. The folder menu lists the editor's projects and recent picker folders; the daemon keeps picker approvals in `daemon-v1/approved-folders.json` (the 50 most recently used) and a moved or replaced picker folder needs the picker again. The daemon keeps provider credentials, encrypted under a key in the Keychain; they never reach main, renderer storage or snapshots. Sign-in links come back from the daemon, and main opens one in the browser only once it has checked it is a provider's sign-in page. Local tools run with your OS permissions: **the working folder is context, not a sandbox**.

The sidebar groups chats into Ready, Working and Idle, with a Settled drawer at its foot. A chat is settled only when you settle it, from the archive button in its header (in the title bar on Agents) or `/settle`; the host keeps that, and Unsettle or sending a message takes it back. The list follows the daemon's chat list watch, so a chat created, sent to, settled or finished in another window or client appears at once; a window becoming visible watches again if that watch stopped.

Typing `@` in the composer searches the chat's working folder on its host (the bundled ripgrep for local chats) and inserts the picked file as a mention. A new chat's draft is shared by Agents and each project's dock, but each keeps its own folder choice (while the chat target's controller lasts), and each mention remembers the folder it was picked in. Send makes mentions relative to the folder it sends in; one outside it is written out as a full path first, and the send waits for a second Send. A mention whose folder isn't known, as after a restart, also holds the first Send, which then takes it as a file in that folder. A path already mentioned from another folder can't be mentioned again.

Typing `/` at the start of a message lists the composer's commands (`src/renderer/chat/commands.ts`): `/new`, `/model`, `/effort`, `/stop`, `/settle`, `/unsettle` and `/clear`, each shown only when it can run. The renderer runs them; a command line sent with Enter runs instead of reaching the agent.

Choosing **New worktree** for a new local chat creates a linked worktree when its first message is sent. The renderer sends only a branch named from the message (`chat/tidy-the-composer`); main asks the daemon (`createChatWorktree`), which makes it from the folder's current commit at `<main worktree>-worktrees/<branch>`, numbering a taken name; a repeat of a creation whose reply was lost asks for the same one. Main then lets the editor open it. It then lists in the project's worktree switcher, and the project's docked chat keeps chats in any of its worktrees.

Quit asks nothing about local agents: they keep running in the daemon, and reopening Moonbase shows where they got to. Quit releases only main's clients and watches. Unsaved editor work still asks first. A daemon with no client connected and no work running exits by itself after 5 minutes.

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

An optional absolute `sshExecutable` overrides `/usr/bin/ssh`. The host runs the [daemon in host mode](../daemon/README.md#remote-host): `remotePort` is its `port`, `expected` and `actorId` come from its `identity.json`, and `token` must be its `token` file. Copy the token without it ever being a command's argument, for example straight into the configuration file:

```sh
ssh my-host 'cat ~/MoonbaseHost/data/token' | node -e '
  const fs = require("node:fs"), file = process.argv[1];
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.token = fs.readFileSync(0, "utf8").trim();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
' /absolute/private/remote-chat.json
```

Configure SSH as described in the [SSH package](../../packages/ssh/README.md), then Connect in the app: from the chats sidebar, or in **Settings › Hosts**, which also switches hosts and shows connection details. A new chat's composer picks the host it runs on. Remote chat uses the same chat, folder and provider clients as local chat, each sent only when the host's signed health advertises it:

- A new chat picks its model and reasoning effort as a local one does. With no picker for the host's disk, its folder menu lists the host's approved roots and the folders directly inside them; without one, the chat runs in a new folder in the host's `chats/`. Editor projects, worktrees, the project dock's folder and Turn into project are local only.
- **Settings › Providers** sets up the host's providers: API keys, and ChatGPT by pasting the final redirect URL after signing in, since the browser's callback can't reach the host. Claude Code uses `claude auth login`, run on the host.
- Remote drafts are kept under one key (`moonbase.chat.remote.v2`) for the configured host, so changing the host blocks sends until those drafts are cleared.

The renderer never receives the endpoint or key, and a remote host's paths never grant access to local files.

## Transcript

The transcript is a [Legend List](https://legendapp.com/open-source/list/), which owns scrolling: virtualization, following the end, holding position when history is prepended or rows resize, and scrolling to a row. The application publishes the rows, keyed `entry:<id>` and `live:<submissionId>`. The renderer draws a run of consecutive activity rows as one card, a list item that keeps its key while rows join its start or end; when the live row leaves a card as the answer starts, the part the reader is in keeps the item: the live row while they follow the live edge, else the card's stored rows. A saved reading position is a stored row in the list's first visible item and the viewport top's offset below that row's own top (a reader in the live response saves the stored row above it); a restore places the item, then holds that row at its offset (through rows joining the card above it) until the reader's first input or a Find reveal. The list reads it only when it places a new `dataset` (opening, or a jump). Rows sit at fractional positions but the list scrolls in whole device pixels, so a restored offset can read a fraction off; an offset that moved less than a device pixel keeps the saved anchor. Rows unmount while scrolled away, so expanded disclosures and unfolded code live in view memory. The rows a selection spans, the focused row, the image viewer's row and the active Find match stay mounted.

## Transcript images

Main serves stored PNG/JPEG transcript images from `moonbase://editor/transcript-image/<token>`, so the CSP is unchanged and the renderer uses a plain `<img>`. The renderer gets a token over chat IPC for one exact source and `{partId, bytes, revision}`. The token is random, holds no path or identity, expires after 10 minutes without a request, and is revoked when the chat document is released or the remote connects or disconnects (then 404). Up to six reads run at once per backend and up to 64 more queue; revocation fails queued reads and cancels running ones. Each request re-reads the bytes through the same validated path Copy uses, refuses sources over 4 MiB (413) and bytes whose signature doesn't match the declared type (415), and responds with `nosniff`, the document CSP and `no-store`. Chromium's decoder enforces pixel and dimension limits. Markdown images stay links. The browser demo serves fixture bytes as Blob URLs instead.

## Checks

Build before native tests and package before package tests. `test:native` runs every Electron project from source; `test:package` runs the `packaged` project and the tests tagged `@packaged` (a Reload, a no-resend Disconnect and images under the production CSP) against the package. PR checks run only `test`; the `nightly` workflow runs `test:browser`, `test:native`, `check:package` and `test:package`.

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

Native tests start the daemon's faux test entry (`apps/daemon/test/faux-daemon.ts`: faux providers, a temporary key file, provider network refused) in temporary user data, with the Bun that `MOONBASE_TEST_BUN` names or the one on PATH; packaged tests run the packaged daemon on a temporary key file. Every daemon a test starts is stopped afterwards. `test:browser` runs the shell in Chromium without Electron; set `MOONBASE_BROWSER_PORT` to isolate concurrent runs (default 4177). `test:native` and `test:package` drive real Electron with temporary repositories and user data; editing needs the daemon, so every native project runs the faux daemon, whose workspace needs the built native helper. `check:package` also checks the daemon's files against `dist` and the Bun executable against its pinned SHA-256, that only they ship beside it, that they embed no checkout or home path or key, that the daemon finds the app's ripgrep and workspace helper beside its bundle and that the notices carry every pinned Bun notice and lockfile package; `test:package` first starts the packaged daemon on temporary data with a faux `claude` and only the system PATH (`test/packaged-daemon.smoke.ts`), searches files outside a Git repository and chats through Claude Code's helper, then opens, saves, searches and Trashes in a temporary repository (it removes its file from the Trash afterwards). Tests inject clipboard and file-opening capabilities.

A new chat's worktree is made under a request id the renderer keeps for that send until it learns the outcome, so a send repeated after a lost reply gets the same worktree and another chat never does. The request id of a turn-into-project call is kept in `chat-requests.json` in the profile, keyed by the chat, so a reload or restart repeats it. Either id survives only an `Uncertain` or `Cancelled` result; any other outcome, including a transient `Unavailable`, drops it.
