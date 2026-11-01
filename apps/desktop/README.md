# Moonbase desktop workbench

A macOS Electron workbench composing the independently proven local editor and optional remote chat through one shared application runtime. Editor and Chat stay mounted across navigation. Human acceptance is **PENDING**; this unsigned composition remains a draft for independent review.

Without `MOONBASE_CHAT_CONFIG`, only workspace capabilities are acquired and Chat explains its unconfigured state. With an explicitly configured private host, the same root adds the reviewed remote-chat and SSH capabilities. Startup and navigation never Connect or Send.

## Run

From the repository root on macOS, with the pinned Bun/Node tooling and Xcode command-line tools available for the **build**:

```sh
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
MOONBASE_USER_DATA="$(mktemp -d -t moonbase-editor)" \
  NX_DAEMON=false bunx nx run @moonbase/desktop:dev
```

Choose an actual Git checkout using Open checkout. Typing retains a recovery draft; Save writes explicitly. File/checkout tabs, Files/Diff, lookup, previews/Keep Open, navigation/order/reopen and file operations come from the public editor module. A single native import asks for its full destination; batch imports ask for an existing folder or checkout root. Replacement requires captured destinations and explicit consent.

`dev` builds and launches the same static custom-scheme UI as the package; rebuild/relaunch after source changes. It intentionally uses the production CSP/bridge rather than a separate development transport. Development requires an explicit fresh absolute `MOONBASE_USER_DATA` directory. Packaged launch accepts that override and otherwise uses the separate `Application Support/Moonbase` namespace. Never point it at an old application's data directory. There is no legacy import.

```sh
NX_DAEMON=false bunx nx run @moonbase/desktop:build
node apps/desktop/scripts/check-renderer.mjs
NX_DAEMON=false bunx nx run @moonbase/desktop:package
MOONBASE_USER_DATA="$(mktemp -d -t moonbase-packaged)" \
  apps/desktop/release/mac-arm64/Moonbase.app/Contents/MacOS/Moonbase
```

The demonstrated package is Apple Silicon. Electron-builder uses `release/mac` for an Intel build; Intel execution is unqualified here. Builds require a compiler; the generated app uses its bundled Electron/Node, native helper, standalone rg and system Git/plutil. The packaged check starts with `PATH=/usr/bin:/bin` and no provider environment. Signing, notarization and distribution are not performed; the bundle still uses Electron's default icon.

## Composition and authority

```text
Electron main: one runtime
  WorkspaceLive → makeEditorClient + shared WorkspaceNative
  optional RemoteChatLive + SshLive → makeChatClient + makeConnectionClient
  owned main-frame/document → EditorSession / ChatIpcSession
    sandboxed preload → public browser clients
      mounted EditorWorkbench / ChatView (Base UI view tabs)
```

Only public application/chat/editor/workspace/UI and registered chat adapters are consumed. The renderer imports the desktop ChatView/bridge and public `@moonbase/chat` controller; privileged native configuration/session and remote/SSH layers stay in main. Main supplies absolute packaged helper/rg paths, acquires the service graph once and disposes it after chat preservation, the editor Save/Discard/Cancel gate, and a second preservation of the latest chat state. A chat storage veto precedes destructive editor choices. Successful Saves and confirmed Discards remain facts if another gate later vetoes Quit. The renderer graph has no Node, filesystem, workspace, Effect runtime, provider or remote implementation.

`EditorSession` is the local transport boundary, not another feature runtime. It validates command/envelope names, bounded unknown input, stable caller ownership, observed operation origin and exact approved checkout identity. The workspace remains the path/schema/domain authority. Native picker approval is required for a new root; arbitrary renderer strings grant none. Captured picker, File-backed drop and consented clipboard files become scoped single-use `WorkspaceNative` tokens. No raw-path import method or generic IPC channel is exposed to page code. Picker, clipboard and drop enter the same public `EditorWorkbenchHandle.importFiles` destination/replacement flow.

The renderer is sandboxed and context-isolated with Node integration disabled. IPC requires the owned webContents, its main frame and the exact current document URL. Navigation, popups, webviews and browser permissions are denied. Local srcdoc frames receive no preload bridge and inherit CSP; network frame loads are blocked by frame-src. The custom scheme serves only built assets under its root, with CSP; asset query strings do not grant document/IPC authority. Error DTOs validate code/target and reconstruct `ApplicationError` in the browser. Cancellation is request-owned; persistent watches have a separate bounded allowance so they cannot exhaust command capacity.

Window close hides the mounted editor, retaining models, selection and undo. Dock activation/Show editor returns to it. Explicit Quit (including Cmd+Q) awaits the public workbench Save/Discard/Cancel gate and exact recovery-publication semantics. Cancel, storage failure or uncertainty keeps the process/window and resolve controls available. After consent the renderer becomes inert before teardown, then disposes controllers/models, subscriptions, IPC and the root runtime. A later Cancel never undoes an earlier completed Save. OS force-kill is not a preservation gate.

## Checks

```sh
NX_DAEMON=false bunx nx run @moonbase/desktop:typecheck
NX_DAEMON=false bunx nx run @moonbase/desktop:lint
NX_DAEMON=false bunx nx run @moonbase/desktop:test
bun run --cwd apps/desktop test:native
bun run --cwd apps/desktop check:package
bun run --cwd apps/desktop test:package
```

Build before desktop tests; package before package tests. Tests use fresh temporary repositories/user-data. The test-only main entry wraps public `ipcMain` delivery for controlled reply loss; it is absent from the shipped `dist`/asar. Clipboard tests replace the main clipboard API with fixtures and never read or write the user's clipboard. File-backed drop uses a genuine selected File with a synthetic React drop; an OS drag gesture remains manual. Native Trash uses only uniquely named temporary fixture files, verifying the returned inode/content before cleanup. Process-restart tests deliberately kill only their own fixture process after observing persisted recovery; this is not physical power-loss proof.

Build-generated resources/notices live only in ignored `dist`/`release`. The workspace helper is resolved through `@moonbase/workspace/filesystem`; rg's pinned upstream release supplies its own notices. Bundled dependency notices are collected automatically from the actual graphs and installed package files. StyleX0.19.1 omits LICENSE from npm, so the build fetches the exact upstream release-commit license and checks its SHA256. Electron's supplied license/Chromium notices remain in the generated package. No copied source notice bundle is maintained.

PENDING: independent app review/hosted checks, including an unexplained initial rapid Open→Find dismissal (cause remains unqualified); real OS directory-picker/clipboard/drag gestures, Finder Put Back, signing/notarization/distribution, VoiceOver/full accessibility, physical full-volume/power-loss durability, performance qualification and human visual/product acceptance. Controlled fixtures and unsigned local execution do not establish those gates.


## Optional remote chat

```sh
MOONBASE_USER_DATA="$(mktemp -d -t moonbase-composed)" \
MOONBASE_CHAT_CONFIG=/absolute/owner-only/host.json \
  NX_DAEMON=false bunx nx run @moonbase/desktop:dev
```

Use the private configuration below; no token, endpoint or credential is sent to the renderer. Connect explicitly. Local checkout roots remain distinct from authenticated remote host/store/cwd identities even when their path strings match. Remote output is descriptive text; there is no file synchronization or remote-to-local open action.

View switching, closing a file/chat view, Hide, Disconnect and client Quit never Stop remote work. Stop keeps the public controller's exact captured submission/task. Quit preserves chat first, asks the existing editor gate, then preserves the latest chat snapshot before disposal. Unknown editor publications retain live work and block Quit/reload until exact resolution. A committed reload releases old document observations/waits and restores persisted drafts on the same root; a veto keeps the mounted document. Renderer loss releases its transport resources, without disposing the root or stopping the host. Recovery covers observed durable snapshots, not instruction-by-instruction crash or power-loss durability.

Desktop binds the shared chat controller's synchronous storage interface to LocalStorage under `moonbase.chat.v1`. The shared module owns the saved schema and preservation rules; desktop owns this namespace and keeps it fixed for the controller's lifetime. No saved-state migration or import occurs.

`test:native` is a separate required macOS qualification gate: it enumerates editor,
configuration, reload/document lifecycle, composed chat, and recovery/cleanup suites
with one worker. `test:package` covers package resources plus packaged reload and
composition; configuration and injected cleanup checks remain source tests.
Composition includes the retained Create/Send/Stop reply-loss, Create readiness and reserved-Send preservation regressions.
Run both gates before desktop qualification; CI build checks alone do not qualify it.
`test:desktop`, `test:composition`, and `test:reload` select named projects for focused runs.

A renderer crash offers native **Recover workbench** and **Quit Moonbase** actions.
Recovery reloads the same window/runtime and approved roots from persisted state;
Quit uses that persisted recovery. Changes since the last publication can be lost.
Once renderer disposal is acknowledged, cleanup errors are reported natively and
Moonbase exits after attempting all cleanup; it never returns to the disposed UI.

Composition tests add to the existing editor/native suites:

```sh
bun run --cwd apps/desktop test:composition
MOONBASE_PACKAGED_TEST=1 bun run --cwd apps/desktop test:composition
```

### Private chat configuration

Create the private configuration outside source control, mode `0600`, owned by the current user, without symlinks. It contains exactly:

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

The private file may additionally specify an absolute `sshExecutable`; normal operation uses `/usr/bin/ssh`. The controlled tests use their own executable only through this privileged configuration. The key must be separate from public settings and match the independently configured host. Never place it in a renderer, URL, command-line argument, log or repository. The renderer receives only public session/profile/health DTOs; no endpoint or provider/database configuration.

Use existing SSH config/agent/keys and verified host-key policy. A dedicated alias must satisfy the SSH module's checked policy (no host-authentication bypass or additional forwards). Moonbase does not change SSH files, install software, start a remote service or stop remote jobs when disconnecting. No test host or provider authorization is assumed.

Start the host **separately on its machine**, using its qualified Node **26.13.0** environment and private host configuration:

```sh
node --experimental-strip-types packages/pi-runtime/src/host.ts /absolute/private/moonbase-host.json
```

See [host setup](../../packages/pi-runtime/README.md) and [SSH policy](../../packages/ssh/README.md). The host configuration fixes the exact host/store/actor, remote cwd and model, plus a new explicit Moonbase database namespace and existing host-side provider auth. The cwd shown here is remote context, not a local filesystem approval. The compiled desktop client uses Electron **45.1.0 / Node 24.22.1**, and imports only the qualified remote adapter and SSH capability, with no host-baseline guard or engine initialization locally.

### Reload checks

Targeted native command (after build/package):
`bun run --cwd apps/desktop test:reload`.
Set `MOONBASE_PACKAGED_TEST=1` and `MOONBASE_RELOAD_EXECUTABLE` to the absolute
unsigned executable for the same packaged checks. Outputs default to
`apps/desktop/test-results` when launched from that app directory; set
`MOONBASE_NATIVE_OUTPUT` explicitly when preserving separate phases.
