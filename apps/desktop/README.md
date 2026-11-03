# Moonbase desktop

The macOS Electron client composes the public browser workbench, headless application, workspace, local Pi, optional SSH and remote Pi modules. Main owns one scoped application runtime, private configuration and native authority; the sandboxed renderer receives browser-safe clients. Feature rules stay in packages. The renderer consumes one `createMoonbaseApplication` from `@moonbase/application`, injecting validated bridge clients, `desktop-primary` recovery identity and separate synchronous `moonbase.chat.local.v1` and existing remote `moonbase.chat.v1` storage. Application owns its document runtime, feature scopes, preservation, admission fences and cleanup; React receives the supplied controllers. Desktop owns main navigation, project/Chat tabs, the separate Chat view and startup/lifecycle presentation. It passes an editor controller and exact checkout to `@moonbase/workbench`, which owns the file sidebar, buffers and editor. The workbench remains mounted across navigation. Desktop also supplies validated native callbacks and private storage.

Local chat is the desktop default without SSH configuration. Main acquires workspace and local Pi once in separate scopes of its runtime; `MOONBASE_CHAT_CONFIG` additionally offers the configured SSH host. Startup/navigation never Connect or Send. Local initialization failure leaves the editor usable and explicit Open Chat panel retries acquisition after the underlying failure is resolved.

## Run and package

From the repository root on macOS with pinned Node/Bun and Xcode command-line tools:

```sh
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
NX_DAEMON=false bunx nx run @moonbase/desktop:dev
```

From `apps/desktop`, run `bun dev`. Development creates and prints a fresh temporary user-data directory for each launch. To reuse development state, set `MOONBASE_USER_DATA` to an absolute directory dedicated to Moonbase development. The launcher leaves temporary data in place on exit for recovery; the OS may later remove it. The packaged default is the separate `Application Support/Moonbase` namespace; never use an old application's data directory. There is no legacy import. `dev` builds the static custom-scheme UI with production CSP/bridge; rebuild/relaunch after changes.

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

Close Chat panel preserves drafts and removes that panel immediately; its cleanup remains owned by the application root. Reopen waits for successful cleanup, and failures stay visible outside the removed panel. The desktop shell derives project tabs from exact controller checkout identities; file tabs remain internal to the project workbench. View switching keeps the editor mounted and detaches/resumes chat observation. See [lifecycle ownership](docs/LIFECYCLE.md).

Optional chat initialization failure leaves local editing usable with a visible status and explicit **Open Chat panel** retry. Unavailable, initialization-failed and cleanup-blocked states come from application snapshots. Required application initialization failure shows a safe recovery view, preserves saved evidence and remains responsive to native Quit.

Window close hides the mounted workbench; explicit Quit runs chat preservation, the editor Save/Discard/Cancel gate, then preservation of the latest chat state. A veto or uncertain publication keeps resolve controls available. Completed Saves/confirmed Discards remain facts. Application fences all controller/workflow admissions before returning consent. The renderer then becomes inert, unmounts presentation resources, awaits application cleanup and returns the existing disposal acknowledgment. Main separately releases its document IPC and privileged runtime. A replacement document must prepare its own application; pending Quit intent is retained but old consent/acknowledgment cannot authorize it. Cancellation acknowledgments await real local watch/wait cleanup; they do not acknowledge mutation rollback or remote termination. Cleanup failures are reported natively after attempting all releases.

Reload requires the editor's synchronous recovery gate and chat preservation before releasing the old document. Renderer crash offers **Recover workbench** or **Quit Moonbase** using persisted recovery and the same runtime/approved roots. Changes since the last publication can be lost; force-kill is not a preservation gate.

## Local agents

Open Chat, leave the target at **Local**, and expand **Provider setup**. Choose **ChatGPT subscription** for the current SDK browser sign-in flow, or OpenAI API key, Anthropic, Google Gemini or OpenRouter. ChatGPT and OpenAI API-key credentials are independent. The newer ChatGPT flow was selected during implementation in place of the ticket’s original legacy Codex/device-code route. It opens only the active provider’s validated sign-in URL and supports a full redirect-URL fallback; it does not offer device codes.

For every new chat, choose an existing working folder through the native picker and a model from a configured provider. The saved chat retains those settings; create another chat to change them. Local read/write/edit/shell tools use your OS permissions: **the working folder is context, not a sandbox**. Local host/store/actor IDs persist in private `local-pi-v1/identity.json`; Pi owns conversations/tasks in that namespace’s SQLite store. No legacy state or external credential files are imported.

Main supplies asynchronous Electron safeStorage encryption to Pi runtime’s atomic private credential store. No plaintext fallback exists. Credentials/answers never enter LocalStorage or controller snapshots; rejected storage/authentication diagnostics stay private. Unlock the Keychain and retry after encrypted storage failure. Unsigned builds may repeat Keychain prompts.

Target switching preserves separate drafts and original retained commands and waits for controller cleanup. Backend work continues across target/view changes, panel close, window Hide and renderer reload. An uncommitted retained Create after process restart requires native approval of its original folder. An exactly matching committed Create recovers its receipt before renewed approval, even when the folder has disappeared; the original settings cannot change.

After normal editor/chat preservation gates and admissions fencing, Quit inspects all local Pi work, including hidden conversations and unfinished admissions. **Keep running** cancels Quit and restores admissions. **Quit** releases local Pi normally; reopening follows Pi saved-task recovery. Neither action synthesizes Stop or rolls back external tool effects. Remote work remains on its host.

See [runtime, credentials and qualification](../../packages/pi-runtime/docs/LOCAL.md) and [desktop lifecycle](docs/LIFECYCLE.md).

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

Start the [Pi host](../../packages/pi-runtime/README.md) separately on its machine and satisfy the [SSH policy](../../packages/ssh/README.md) with existing config/agent/keys and verified known hosts. The host uses Node 26.13.0; the desktop uses its bundled Electron 45.1.0 / Node 24.22.1 for local Pi and its remote adapter. Connect explicitly.

Remote host/store/cwd identity never grants local checkout access, even for equal path strings. There is no file synchronization or remote-to-local open action. Hide, view switching, Disconnect, renderer loss and client Quit never Stop remote work. Stop uses the controller's exact captured submission/task.

Desktop supplies separate local storage under `moonbase.chat.local.v1` and keeps remote LocalStorage under `moonbase.chat.v1` for the controller's lifetime; the [application chat feature](../../packages/application/docs/CHAT.md) owns schema/preservation. No migration/import occurs.

See [local acceptance evidence](docs/LOCAL-ACCEPTANCE.md) for source, controlled, embedded, native and packaged results and remaining manual checks.

## Private source and test map

`src/main.ts` is the sole privileged composition root: user-data/single-instance setup, assets/CSP, runtime acquisition, window/security policy, menu and installation order. Its private owners create no runtime and expose no package API:

| Source | Owns | Focused source checks |
| --- | --- | --- |
| `src/main/native-actions.ts` | Native consent, bounded Finder plist conversion and supplied capture/release | `test/native-actions.test.ts`; session late-capture regressions |
| `src/main/ipc.ts` | Exact live window/main-frame/document guard and command/config/cancel registration with idempotent teardown | `test/main-ipc.test.ts` |
| `src/main/window-lifecycle.ts` | Ready, document replacement/crash, Hide/Show, Quit identities/stages, cleanup evidence and final release order | `test/window-lifecycle.test.ts` |
| `src/main/chat-backends.ts` | Existing local/remote sessions, explicit local retry, folder/provider document ownership and local activity inspection | `test/chat-backends.test.ts` |
| `src/{session,ipc-lifetime}.ts`, `src/chat/session.ts` | Approval, payload policy, request/watch lifetimes and captured finalizers | `test/{session,session-lifetime,ipc-scopes,chat-session}.test.ts` |

`test/main-window.ts` supplies a narrow controlled window adapter for the IPC/lifecycle tests. Source discovery remains `test/*.test.ts`. The test-only native harness still wraps actual IPC registration and imports shipped `dist/main.mjs`; production imports no test hooks. Existing native projects cover real Electron navigation/IPC, reload, crash recovery, local chat and composition; package projects exercise the final archive. Build/archive checks require all private main owners, and the renderer/preload graph checks reject the privileged subtree. See [privileged extraction evidence](docs/PRIVILEGED-VALIDATION.md).

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

`test:browser` runs the desktop shell with memory/faux capabilities in Chromium, covering navigation, focus/undo retention, Quit prompts and Chat cleanup without Electron. Its fixture lives in `demo/`, runs with `demo:browser` and stays outside shipped renderer inputs.

`test:local` exercises the local UI with network-disabled faux streams and a test cipher. `test:native` covers it alongside editor, configuration, reload, composition and recovery with one worker. `test:package` covers resources, reload and composition. Focused projects: `test:desktop`, `test:composition`, `test:reload`. For focused packaged runs set `MOONBASE_PACKAGED_TEST=1`; reload also accepts absolute `MOONBASE_RELOAD_EXECUTABLE`. `MOONBASE_NATIVE_OUTPUT` selects the output directory.

Tests use temporary repositories/user-data, fixture clipboard APIs and owned processes. Native Trash checks only temporary files. Reply-loss instrumentation is excluded from shipped output. Controlled drop/restart checks do not establish OS gesture or power-loss behavior.

Build-generated resources/notices live in ignored `dist`/`release`. Notices come from actual bundled assets/dependencies, including Monaco workers/fonts, ripgrep and Electron/Chromium. Missing npm license files for StyleX, Pi and Standard Webhooks are fetched from exact upstream release commits and SHA256-checked; data-uri-to-buffer supplies its notice in its bundled README.

Human acceptance remains **pending**. Real picker/clipboard/drag gestures, Finder Put Back, VoiceOver/full accessibility, performance, physical durability, Intel execution and signing/notarization/distribution require separate qualification. The previously observed rapid Open→Find dismissal remains unexplained; controlled tests do not establish its resolution.
