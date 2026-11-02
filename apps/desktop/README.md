# Moonbase desktop

The macOS Electron client composes the public editor, headless chat, workspace, SSH and remote Pi modules. Main owns one scoped application runtime, private configuration and native authority; the sandboxed renderer receives browser-safe clients. Feature rules stay in packages. The renderer consumes one `createMoonbaseApplication` from `@moonbase/application`, injecting validated bridge clients, `desktop-primary` recovery identity and synchronous `moonbase.chat.v1` storage. Application owns its document runtime, feature scopes, preservation, admission fences and cleanup; React receives the supplied controllers. Editor and Chat remain mounted across navigation.

Without `MOONBASE_CHAT_CONFIG`, the root acquires only workspace capabilities. With configuration, it adds SSH and remote chat. Startup/navigation never Connect or Send.

## Run and package

From the repository root on macOS with pinned Node/Bun and Xcode command-line tools:

```sh
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
MOONBASE_USER_DATA="$(mktemp -d -t moonbase-editor)" \
  NX_DAEMON=false bunx nx run @moonbase/desktop:dev
```

Development requires a fresh absolute `MOONBASE_USER_DATA` directory. The packaged default is the separate `Application Support/Moonbase` namespace; never use an old application's data directory. There is no legacy import. `dev` builds the static custom-scheme UI with production CSP/bridge; rebuild/relaunch after changes.

```sh
NX_DAEMON=false bunx nx run @moonbase/desktop:build
bun run --cwd apps/desktop check:renderer
NX_DAEMON=false bunx nx run @moonbase/desktop:package
MOONBASE_USER_DATA="$(mktemp -d -t moonbase-packaged)" \
  apps/desktop/release/mac-arm64/Moonbase.app/Contents/MacOS/Moonbase
```

The Apple Silicon app bundles Electron/Node, the native helper and standalone ripgrep; system Git/plutil remain required. Intel output uses `release/mac`, with execution unqualified. Packaging is unsigned, uses Electron's default icon and performs no notarization/distribution.

## Authority and preservation

Native picker approval grants an exact checkout identity. Picker, clipboard and File-backed drop produce scoped `WorkspaceNative` references and enter the public editor import dialog; renderer path strings grant no filesystem authority. IPC uses shared request/reply schemas and validates bounded input, caller ownership and the exact main frame/document. Workspace owns path/domain validation. Navigation, popups, webviews and browser permissions are denied; CSP restricts asset/frame loading.

Close Chat panel preserves drafts and removes that panel immediately; its cleanup remains owned by the application root. Reopen waits for successful cleanup, and failures stay visible outside the removed panel. View switching keeps the editor mounted and detaches/resumes chat observation. See [lifecycle ownership](docs/LIFECYCLE.md).

Optional chat initialization failure leaves local editing usable with a visible status and explicit **Open Chat panel** retry. Unavailable, initialization-failed and cleanup-blocked states come from application snapshots. Required application initialization failure shows a safe recovery view, preserves saved evidence and remains responsive to native Quit.

Window close hides the mounted workbench; explicit Quit runs chat preservation, the editor Save/Discard/Cancel gate, then preservation of the latest chat state. A veto or uncertain publication keeps resolve controls available. Completed Saves/confirmed Discards remain facts. Application fences all controller/workflow admissions before returning consent. The renderer then becomes inert, unmounts presentation resources, awaits application cleanup and returns the existing disposal acknowledgment. Main separately releases its document IPC and privileged runtime. A replacement document must prepare its own application; pending Quit intent is retained but old consent/acknowledgment cannot authorize it. Cancellation acknowledgments await real local watch/wait cleanup; they do not acknowledge mutation rollback or remote termination. Cleanup failures are reported natively after attempting all releases.

Reload requires the editor's synchronous recovery gate and chat preservation before releasing the old document. Renderer crash offers **Recover workbench** or **Quit Moonbase** using persisted recovery and the same runtime/approved roots. Changes since the last publication can be lost; force-kill is not a preservation gate.

## Optional remote chat

Set `MOONBASE_CHAT_CONFIG` to an absolute private JSON file outside source control: mode `0600`, owned by the current user, without symlinks.

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

An optional absolute `sshExecutable` overrides `/usr/bin/ssh`. Keep the key separate from public settings and out of renderers, URLs, arguments, logs and the repository. Main validates configuration and exact host/store/actor authority; the renderer receives no endpoint, credentials or database configuration.

Start the [Pi host](../../packages/pi-runtime/README.md) separately on its machine and satisfy the [SSH policy](../../packages/ssh/README.md) with existing config/agent/keys and verified known hosts. The host uses Node 26.13.0; the desktop remote adapter uses Electron 45.1.0 / Node 24.22.1 without local Pi/provider initialization. Connect explicitly.

Remote host/store/cwd identity never grants local checkout access, even for equal path strings. There is no file synchronization or remote-to-local open action. Hide, view switching, Disconnect, renderer loss and client Quit never Stop remote work. Stop uses the controller's exact captured submission/task.

Desktop supplies LocalStorage under `moonbase.chat.v1` for the controller's lifetime; the [application chat feature](../../packages/application/docs/CHAT.md) owns schema/preservation. No migration/import occurs.

## Checks and limits

Build before source/native tests; package before package tests:

```sh
bun run --cwd apps/desktop typecheck
bun run --cwd apps/desktop lint
bun run --cwd apps/desktop test
bun run --cwd apps/desktop test:native
bun run --cwd apps/desktop check:package
bun run --cwd apps/desktop test:package
```

`test:native` covers editor, configuration, reload, composition and recovery with one worker. `test:package` covers resources, reload and composition. Focused projects: `test:desktop`, `test:composition`, `test:reload`. For focused packaged runs set `MOONBASE_PACKAGED_TEST=1`; reload also accepts absolute `MOONBASE_RELOAD_EXECUTABLE`. `MOONBASE_NATIVE_OUTPUT` selects the output directory.

Tests use temporary repositories/user-data, fixture clipboard APIs and owned processes. Native Trash checks only temporary files. Reply-loss instrumentation is excluded from shipped output. Controlled drop/restart checks do not establish OS gesture or power-loss behavior.

Build-generated resources/notices live in ignored `dist`/`release`. Notices come from actual bundled assets/dependencies, including Monaco workers/fonts, ripgrep and Electron/Chromium. StyleX's missing npm license is fetched from its exact upstream release commit and SHA256-checked.

Human acceptance remains **pending**. Real picker/clipboard/drag gestures, Finder Put Back, VoiceOver/full accessibility, performance, physical durability, Intel execution and signing/notarization/distribution require separate qualification. The previously observed rapid Open→Find dismissal remains unexplained; controlled tests do not establish its resolution.
