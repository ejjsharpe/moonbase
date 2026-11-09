# Moonbase desktop

The macOS Electron app. It composes the workbench, headless application, workspace, local Pi and optional SSH/remote Pi modules. `src/main.ts` is the privileged composition root and owns native capabilities; the sandboxed renderer receives browser-safe clients only.

The renderer opens only roots chosen in the native picker, already known, listed by `listWorktrees` for an approved checkout, or opened by main with `EditorSession.openFolderProject`. It cannot call `createWorktree` with a location of its own; a new chat's worktree is made by main instead (below). Copy Path and Reveal in Finder likewise send main a checkout and relative paths: main writes the clipboard itself and reveals only paths that still resolve inside the checkout once links are followed. A clipboard import asks for consent only when the clipboard holds Finder files, checking for their type without reading anything, and finds none otherwise, so ⌘V can paste the tree's own entries; a declined prompt returns null, so it pastes nothing.

## Window

A title bar runs across the top: the window controls, the sidebar button, then the open file or view's title over the content column, and buttons for project chats (⌘J) and a new chat. ⌘B (or ⌃⌘S) hides the main sidebar: the explorer, or the chat list in Agents. The project rail sits under the title bar; ⌃⌥⌘S or the button at its foot hides it, and it then slides over the window while the pointer is at the left edge. Both choices are kept in renderer local storage.

## Run

From the repository root, on macOS with Xcode command-line tools:

```sh
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
NX_DAEMON=false bunx nx run @moonbase/desktop:dev
```

`bun dev` in `apps/desktop` does the same build-then-launch. Development keeps its state between launches in a `Moonbase Dev` profile beside the packaged app's (on macOS, `~/Library/Application Support/Moonbase Dev`); set `MOONBASE_USER_DATA` to an absolute directory to use another. Never point it at real application data you care about. Rebuild and relaunch after changes.

`bun run dev:mock` launches with a separate `Moonbase Dev Mock` profile. Its first launch seeds scripted local chats played by a faux model, covering thinking, completed and failed tool steps, an edit and Markdown answers. Their edits touch only a `mock-project` folder inside that profile, and the chat in this repository only reads. Delete the profile to seed again.

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

Local chat needs no configuration: choose a provider in **Settings › Providers** (⌘, or the gear at the foot of the rail; the model menu links there too), then a model and, optionally, a working folder. A chat in Agents starts with **No project**: it runs in a new empty folder the runtime makes under `local-pi-v1/chats`, and lists as No project. Moonbase never deletes a chat's folder. **Turn into project** in the chat's header (in the title bar on Agents) opens that folder as a plain-folder project where it is; the chat then lists under it, and **Initialize Git** adds branch and diff controls. A project's docked chat always uses one of the project's folders. **Claude subscription** uses an installed Claude Code CLI signed in with `claude auth login` (and out with `claude auth logout`), and counts against that Claude plan. A local chat may use a folder chosen in the native picker or a checkout the editor approved, such as the project root in its docked chat. The folder menu lists the editor's projects and recent picker folders; main keeps picker approvals in `local-pi-v1/approved-folders.json` (the 50 most recently used picker folders, and up to 200 chat worktrees counted separately) and re-checks each folder's identity on use, so a moved or replaced folder needs the picker again. Credentials are encrypted with Electron safeStorage (there is no plaintext fallback) and never reach renderer storage or snapshots. Local tools run with your OS permissions: **the working folder is context, not a sandbox**.

The sidebar groups chats into Ready, Working and Idle, with a Settled drawer at its foot. A chat is settled only when you settle it, from the archive button in its header (in the title bar on Agents) or `/settle`; the host keeps that, and Unsettle or sending a message takes it back.

Typing `@` in the composer searches the chat's working folder on its host (the bundled ripgrep for local chats) and inserts the picked file as a mention. A new chat's draft is shared by Agents and each project's dock, but each keeps its own folder choice (while the chat target's controller lasts), and each mention remembers the folder it was picked in. Send makes mentions relative to the folder it sends in; one outside it is written out as a full path first, and the send waits for a second Send. A mention whose folder isn't known, as after a restart, also holds the first Send, which then takes it as a file in that folder. A path already mentioned from another folder can't be mentioned again.

Typing `/` at the start of a message lists the composer's commands (`src/renderer/chat/commands.ts`): `/new`, `/model`, `/effort`, `/stop`, `/settle`, `/unsettle` and `/clear`, each shown only when it can run. The renderer runs them; a command line sent with Enter runs instead of reaching the agent.

Choosing **New worktree** for a new local chat creates a linked worktree when its first message is sent. The renderer sends only a branch named from the message (`chat/tidy-the-composer`); main makes it from the folder's current commit at `<main worktree>-worktrees/<branch>`, numbering a taken name, and approves it as the chat's working folder. It then lists in the project's worktree switcher, and the project's docked chat keeps chats in any of its worktrees.

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

An optional absolute `sshExecutable` overrides `/usr/bin/ssh`. Start the [Pi host](../../packages/pi-runtime/README.md) on the remote machine and configure SSH as described in the [SSH package](../../packages/ssh/README.md), then Connect in the app: from the chats sidebar, or in **Settings › Hosts**, which also switches hosts and shows connection details. A new chat's composer picks the host it runs on. The renderer never receives the endpoint or key, and a remote host's paths never grant access to local files.

## Transcript

The transcript is a [Legend List](https://legendapp.com/open-source/list/), which owns scrolling: virtualization, following the end, holding position when history is prepended or rows resize, and scrolling to a row. The application publishes the rows, keyed `entry:<id>`, `live:<submissionId>` and `tool:<taskId>`. The renderer draws a run of consecutive activity rows as one card, a list item that keeps its key while rows join its start or end; when the live row leaves a card as the answer starts, the part the reader is in keeps the item: the live row while they follow the live edge, else the card's stored rows. A saved reading position is a stored row in the list's first visible item and the viewport top's offset below that row's own top (a reader in the live response saves the stored row above it); a restore places the item, then holds that row at its offset (through rows joining the card above it) until the reader's first input or a Find reveal. The list reads it only when it places a new `dataset` (opening, or a jump). Rows sit at fractional positions but the list scrolls in whole device pixels, so a restored offset can read a fraction off; an offset that moved less than a device pixel keeps the saved anchor. Rows unmount while scrolled away, so expanded disclosures and unfolded code live in view memory. The rows a selection spans, the focused row, the image viewer's row and the active Find match stay mounted.

## Transcript images

Main serves stored PNG/JPEG transcript images from `moonbase://editor/transcript-image/<token>`, so the CSP is unchanged and the renderer uses a plain `<img>`. The renderer gets a token over chat IPC for one exact source and `{partId, bytes, revision}`. The token is random, holds no path or identity, expires after 10 minutes without a request, and is revoked when the chat document is released or the remote connects or disconnects (then 404). Up to six reads run at once per backend and up to 64 more queue; revocation fails queued reads and cancels running ones. Each request re-reads the bytes through the same validated path Copy uses, refuses sources over 4 MiB (413) and bytes whose signature doesn't match the declared type (415), and responds with `nosniff`, the document CSP and `no-store`. Chromium's decoder enforces pixel and dimension limits. Markdown images stay links. The browser demo serves fixture bytes as Blob URLs instead.

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
