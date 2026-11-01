# Standalone remote chat proof

A small Electron client for one configured SSH host, independent of the editor. The privileged process composes `RemoteChatLive.pipe(Layer.provideMerge(SshLive(config)))` once, then supplies the same process runtime to `makeChatClient` and `makeConnectionClient`. IPC calls enter those shared handlers. Pi, SQLite, model credentials and task execution stay in the separately operated host. Startup is disconnected; no connection, Send or model call is automatic.

## Run

Use the pinned workspace dependencies (`bun install --frozen-lockfile`) and build from the repository root:

```sh
bun run --cwd apps/chat-probe build
MOONBASE_CHAT_CONFIG=/absolute/private/chat-client.json \
MOONBASE_CHAT_DATA=/absolute/new/moonbase-chat-proof-data \
  bun run --cwd apps/chat-probe start
```

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

Use existing SSH config/agent/keys and verified host-key policy. A dedicated alias must satisfy the SSH module's checked policy (no host-authentication bypass or additional forwards). This app does not change SSH files, install software, start a remote service or stop remote jobs when disconnecting. No test host or provider authorization is assumed.

Start the host **separately on its machine**, using its qualified Node **26.13.0** environment and private host configuration:

```sh
node --experimental-strip-types packages/pi-runtime/src/host.ts /absolute/private/moonbase-host.json
```

See [host setup](../../packages/pi-runtime/README.md) and [SSH policy](../../packages/ssh/README.md). The host configuration fixes the exact host/store/actor, remote cwd and model, plus a new explicit Moonbase database namespace and existing host-side provider auth. The cwd shown here is remote context, not a local filesystem approval. The compiled desktop client uses Electron **45.1.0 / Node 24.22.1**, and imports only the qualified remote adapter and SSH capability, with no host-baseline guard or engine initialization locally.

## Workflow and uncertainty

1. Connect explicitly. Only authenticated matching health becomes connected. The verified host supplies the fixed cwd/model and saved-chat list.
2. Create or open a saved chat. Type a bounded message; Send or Cmd/Ctrl+Enter captures its exact target and text. Live snapshots replace prior output; they never append an unbounded event feed. At most 32 current and 32 older previews are held, each host-bounded to 4 KiB, with at most eight live tool previews. Reading another older page replaces the previous older page; no stored history is deleted.
3. Stop captures the current submission/task (including a null queued task) at the click. Retained Stop retries never follow a successor. `pending` means cancellation has not joined, not that remote work ended or tool effects were undone.
4. Disconnect/reconnect, close a view, hide, reload or Quit. These change connectivity/observation only. Reconnect reads the saved chat and exact Send receipt without resending. Host shutdown and explicit Stop remain separate actions.

The browser controller synchronously preserves a full immutable Create/Send/Stop input **before disclosure** in `moonbase.chat-proof.v1` within the explicit Electron user-data namespace. It retains at most 16 unresolved commands and 32 nonempty drafts (32 KiB each), scoped to exact host/store/actor/conversation. It stores no transcript, execution events, scheduler or provider state. Successful resolution clears only the captured draft text, preserving newer edits. Null/reserved lookup, cancellation, lost response and transport errors retain the original identity and text. Busy reservations remain visible. Query is read-only; retry first queries, then explicitly repeats the original input only if still unresolved. No title/latest-chat/task guessing. Create has no read-only receipt query in v0, so listing cannot prove its identity; explicitly retrying the original Create recovers its exact committed conversation. Stop queries likewise do not replace its captured target.

A corrupt, foreign-context, full or externally changed local snapshot remains untouched and blocks new mutations. A failed live edit stays visible in memory and blocks Quit: keep the window open and copy the latest text before repairing storage. The app never claims reload safety after a failed write. LocalStorage and ordinary filesystem writes provide no physical power-loss guarantee. One app instance owns a data directory; the controller also detects an externally changed stored snapshot before replacing it. This is a preservation fence, not an atomic multi-process database.

## Reuse in a composition

The `@moonbase/chat-probe/ui` export is browser-safe and installs no services/runtime. Supply clients from the consumer's existing command center and storage with the same preservation policy:

```tsx
const controller = createChatProof({ chat, connection, context, storage });
root.render(<ChatProof controller={controller} />);
// Before a destructive close: controller.preserve() must succeed.
// Hide: controller.detach(); Show: await controller.start();
// Final view disposal: controller.dispose(); remote jobs continue.
```

The controller owns draft/pending DTOs and bounded rendered state. The caller owns its lifetime and client/runtime disposal. `ChatProof` starts observation on mount; a reusable consumer must preserve before unmounting if edits could not be saved. This proof hides its window on close, detaches observations while hidden and reads state again when shown. Quit requires a correlated preservation acknowledgement; failed preservation keeps the window/runtime alive. A renderer crash leaves the last successful snapshot for reload, with no automatic retry. Forced termination can lose an unpreserved live edit.

IPC is restricted to the exact top-level proof document and a bounded operation allowlist. Sandboxed/context-isolated preload exposes no generic channel, Node, filesystem, endpoint or key. Navigation, child windows, webviews and permissions are denied. The document inherits shared StyleX tokens/recipes and document font, including future portals. Base UI handles the proof's controls; there is no editor panel or import.

## Checks and package

```sh
bun run --cwd apps/chat-probe typecheck
bun run --cwd apps/chat-probe lint
bun run --cwd apps/chat-probe test
bun run --cwd apps/chat-probe package
bun run --cwd apps/chat-probe test:desktop
node apps/chat-probe/scripts/check-artifacts.mjs
```

Native tests need an explicitly coordinated foreground slot. They use a separate Node 26 host, real SQLite/production HTTP and a controlled TCP forwarding child, not a real SSH host or provider. The build rejects host/editor code in the privileged client and all privileged code in the renderer. Packaging creates an unsigned macOS directory app using the installed Electron version. Upstream notices are generated from the actual client graph/package release files into output; no manual license bundle is maintained. Host/SDK distribution notices are a separate pending gate, because the SDK is not shipped in this desktop app.

See [evidence](EVIDENCE.md) and [provenance](PROVENANCE.md). **PENDING HUMAN ACCEPTANCE.** Real SSH/host-key/agent/ProxyJump, real provider, signed/notarized distribution, VoiceOver/native manual acceptance and power loss remain unqualified.

Current qualification note: the fixed Pi adapter (`235eb27`) and coordinator registration (`84923f2`) are adopted on base `chore/chat-integration` at `132d273`. Current proof26/type/lint/build/frozen and **11 actual source/package Electron checks** pass, with refreshed screenshots/build/archive hashes. Six native cases cover postcommit Create/Send/Stop replies lost on connection teardown; reconnect keeps original identities and never resends. The historical Create-disabled observation did not reproduce in 24 reload/fill/refresh cycles and remains unattributed. Foreground resources are confirmed stopped; fresh independent review and human acceptance remain pending.
