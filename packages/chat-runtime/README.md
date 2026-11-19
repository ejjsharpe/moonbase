# Chat runtime

`@moonbase/chat-runtime` implements the contracts `ChatService` on Pi Durable, which owns execution, transcripts and tasks. It also provides the daemon's folder and control service, provider sign-in and encrypted credential storage. It owns no wire protocol: the daemon composes these layers and serves them over [`@moonbase/daemon-protocol`](../daemon-protocol/README.md). Layers create no runtime; the process root provides the platform (`NodeServices` from `@effect/platform-node`).

Inside, `commands/` holds the `Host` (the open store and the gates every command runs through) and one file per command family; `transcript/` builds saved and live transcripts and Find; `history/` builds history pages and snapshots; `chat-list/` lists and watches chats.

| Export | What it gives |
| --- | --- |
| `.` | `LocalPiRuntimeLive(config)`, the privileged `LocalPiControl`, and `LocalHostLive(config)`: the contracts `LocalHostService` over `LocalPiControl` and the daemon's `FolderApprovals` |
| `./providers` | `ProviderSetupLive`, provider sign-in for named owners |
| `./credentials` | `makeCredentialStore`, `makeKeyEncryption` and the key sources `makeKeychainKeySource`, `makeKeyFileSource`, `createMemoryKeySource` |
| `./local-models` | `createLocalModels(credentials)`, the local provider catalog |
| `./claude-code` | `createClaudeCodeSubscription` and `closeClaudeCodeProcesses`: Claude Pro/Max through the local Claude Code CLI ([pi-claude-code](https://github.com/earendil-works/pi-claude-code)) |

## Rules worth knowing

- **Errors (D14).** The runtime fails with the tagged errors of `@moonbase/contracts` `chat-errors`, `folder-errors` and `provider-errors`. `safeError` keeps those and hides anything else (Pi's or the platform's) as `ChatStoreError` (`failed`), or `UncertainError` for a mutation that may have committed. A call that may have taken effect (a Send's submission or a Stop's abort) is uncertain whatever it fails with, unless Pi proves a refusal, and so is a mutation's defect.
- **Qualified runtimes only.** It runs on Node 26.13 or newer or exactly Bun 1.4.4; anything else, Electron included, is refused (`IncompatibleHostError` `runtime`) before the store opens.
- **Mutations are never resent.** They carry request IDs bound to their full input. A lost or unproved reply is `UncertainError`; callers recover with the original request, and reconnects never resend.
- **A working folder is tool context, not a filesystem sandbox.**
- **Chats without a project.** A `createChat` without `cwd` gets a new private folder under `chatFolders` (`ownFolder: true`); it is refused when `chatFolders` is unset or inside a Git checkout. The runtime never deletes a chat's folder; it removes only an empty one it made for a request that made no chat.
- **Decode what comes back, trust what came in.** Inputs were decoded by the daemon protocol's server. The runtime decodes its stored records on each read and the cursors clients return.
- **Cursors** are base64url JSON with no secret (a token holder can already read what they reach), decoded against their schema when opened. A transcript cursor is refused for any read but the one it continues.
- **Closing** refuses new commands, aborts reads and waits for every admitted mutation (a Send included) to finish before the store closes. The close has no deadline of its own.
- **Stop** targets only the captured submission or task. Cancelling or disconnecting a client never stops remote work.
- **Provider sign-in** runs one flow per provider; starting one cancels another owner's. An owner unheard from for 30 minutes loses its flow, at most 64 owners hold one, and the 256 most recently released stay refused.
- **Sign-in URLs** are checked against the providers' sign-in origins (`https://auth.openai.com`) by the daemon and again by the client, which opens them. The daemon never opens a browser.
- **Credentials.** One file per provider, AES-256-GCM with a random nonce and the provider id authenticated, under a 256-bit key from one source: a macOS Keychain item written and read by `/usr/bin/security -i` with every command on stdin, never in arguments, or an explicit private key file (0600, owned by the user, not a symlink). Like such a key file, the Keychain item is readable by any process running as the same user, through `/usr/bin/security`. An unusable source is `CredentialKeyError` and no other source is tried.
- **Claude Code** runs the local `claude` CLI, which owns sign-in; Moonbase stores no Claude credentials, and Pi still executes every tool. Hosts close its warm workers with `closeClaudeCodeProcesses()`.

## Checks

```sh
bun run --cwd packages/chat-runtime typecheck
bun run --cwd packages/chat-runtime lint
bun run --cwd packages/chat-runtime test
bun run --cwd test/chat test
```

Tests run under `bun test`, the runtime the daemon ships on, with controlled providers and temporary SQLite stores. `test:linux` leaves out `test/macos/`, and `test:macos` runs only it; its temporary-keychain test runs only with `MOONBASE_TEST_KEYCHAIN=1`, which CI sets on its macOS runner.
