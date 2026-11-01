# Desktop compatibility foundation

For the current integrated checks, fixes and user-confirmed manual VoiceOver validation, see [V1 acceptance evidence](v1-acceptance.md). The sections below preserve the scope and limitations of each earlier implementation slice.

This is the implementation slice for [Prove packaged desktop launch and installed-tool compatibility](https://github.com/ejjsharpe/escode/issues/12), governed by [the v1 specification](https://github.com/ejjsharpe/escode/issues/11). The foundation now hosts the one-checkout file/Git editor slice from issue 13; it is not the completed v1.

## Run

Use Bun 1.4.4 and Node 26.13.0 (the tested tooling runtime).
Apple's Command Line Tools (`xcode-select --install`) are needed to compile the
small macOS filesystem helper. The packaged app includes that helper and does
not need a compiler or shell-installed Node to save files.

- `bun install --frozen-lockfile`
- `bun run dev`
- `bun run typecheck`, `bun run lint`, `bun run test`
- `bun run build`, `bun run package`
- `bun run smoke` builds/packages first and runs the Electron tests.

Nx owns orchestration. Vite Plus provides build, development, lint and Vitest. Versions are exact in manifests and bun.lock; Vitest 5.0.5 is supplied by Vite Plus 1.4.0. Electron 45 no longer declares an install lifecycle script, so the root postinstall explicitly invokes its binary installer. Bun trusts Nx and esbuild lifecycle scripts. The blocked electron-winstaller script concerns Windows packaging, outside this macOS check.

The unsigned local app is at `apps/desktop/release/mac-arm64/escode.app`. Signing, notarization and distribution are not established by this check.

## Runtime and trust boundary

The sandboxed renderer has context isolation and no Node integration. Its frozen preload API contains argument-free `toolStatus()` and a typed project capability for open/status/files/read/save/diff. Project opening uses a host-owned native directory chooser; subsequent calls operate only on that canonical checkout. Paths and arguments are validated in the host, and symbolic links are rejected. The host rejects invalid arguments, foreign senders, subframes and unexpected document URLs. Navigation, popups and permission requests are denied. Production CSP permits bundled scripts and worker assets, with inline styles for Monaco.

Tools are discovered through the inherited PATH followed by conventional user Bun/Cargo/local, Homebrew and system locations. No login shell or shell startup files are executed. Nonstandard install locations currently need an inherited PATH entry. The npm/Bun Codex JavaScript launcher runs using Electron's bundled Node mode; it does not depend on a shell-installed Node executable. Executables remain user-installed software, not bundled Git/Codex.

## Codex support policy

Stable codex-cli **0.163.0 or newer** is admitted; **0.165.0** remains the tested
baseline. Versions below the minimum and unrecognized/prerelease version strings
return setup guidance without starting app-server. A newer version must still pass
protocol initialization and the existing account/configuration/thread response
checks. Admission is not a claim that every future release is compatible. Failures
identify the selected executable and detected version; tool status retains these
diagnostics even when its protocol probe fails. Discovery continues to respect PATH
before fallback locations, so multiple installations do not silently switch after a
failed connection. The probe uses newline-delimited stdio JSON-RPC: initialize/initialized, account/read (refreshToken false), and config/read (includeLayers false). It sends no turns, changes no configuration and starts no provider thread.

Only authentication presence and model, reasoning effort, approval policy and sandbox mode are returned to the renderer. Tokens, account details, raw configuration and configuration layers are excluded. Errors have bounded guidance; the probe times out and terminates its child.

The current probe reads configuration in the home directory, proving access outside a development shell. Checkout-specific resolution, requirements and actual new/resumed thread effective settings remain acceptance gates for the subsequent chat implementation. Null values mean the config/read field is unset; they are not claimed as resolved thread defaults.

Official references: [StyleX Vite integration](https://stylexjs.com/docs/learn/installation/vite/), [Vite Plus configuration](https://viteplus.dev/config/), [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server).

## Evidence

Test host: macOS 26.3.1 (25D2128), arm64; Bun 1.4.4, Node 26.13.0.

- Clean isolated manifest/lockfile installation passed, including explicit Electron binary installation.
- Standard TypeScript checking and Oxlint passed.
- Production renderer and bundled CommonJS host/preload build passed; electron-builder produced an unsigned arm64 app using Bun's dependency collector.
- Packaged Playwright launch with PATH=/usr/bin:/bin passed: production StyleX background, Monaco rendering and JSON-worker error diagnostics, Git 2.50.1 discovery, Codex 0.165.0 discovery, authenticated account/read and config/read, absence of renderer require and the single-capability bridge.
- Development Electron smoke passed: changing a StyleX color updated the visible screen, then the test restored the source.
- The missing-tool host test passed after first failing before implementation.

The smoke tests require this machine's separately authenticated supported Codex installation. They are live compatibility checks, not portable hermetic unit tests. No paid model turn is sent. Intel macOS, other Codex versions, Finder/Gatekeeper distribution, VoiceOver and the later editor/chat workflows are not covered here.


## File/Git slice evidence and limits

Real temporary-repository tests cover HEAD/index/disk baselines, unborn HEAD,
literal wildcard filenames, binary/oversized errors, external conflicts,
concurrent app saves, an external write during save staging, temporary-file cleanup,
invalid binary editor content rejected before disk mutation, and save failures. The Electron workflow covers retained
buffers, Cmd+S, comparison/cancellation/overwrite, external diff refresh,
selection restoration and a failed save retaining edits. Conflict resolution keeps
view navigation disabled; a second external change requires another explicit
overwrite decision, and Reload reads the latest disk version. The desktop screenshot
is captured by `tests/project.spec.ts`.

Files are UTF-8, limited to 2 MiB. Git command output is bounded to 16 MiB.
Symbolic links are unavailable. Status refresh polls at two seconds. File service
operations currently run synchronously in the host; very large repository status
may pause the UI. Dirty buffers are retained only for the process lifetime;
crash recovery and close/quit prompts belong to later v1 slices.

Saving stages and flushes a sibling file, rechecks disk content hashes, then
renames atomically. Concurrent app saves are serialized. The agreed save policy
for issue 13 follows VS Code's practical check-before-save guarantee: detected
external changes require Compare, explicit Overwrite, Reload or Cancel. Another
process can still write between the final check and replacement. This interval
is explicitly accepted; no cross-process transaction or retained disk-version
history is promised. A deterministic test places a separate process's write in
that interval and documents the accepted outcome. The earlier staging race test
continues to require a conflict and preserve external disk contents.

This policy was explicitly chosen on 2026-10-29 after reviewing VS Code's
[separate validation and write](https://github.com/microsoft/vscode/blob/a48dd23e2ac513740bd36066ae4de756337bba20/src/vs/platform/files/common/fileService.ts#L383-L536)
and [temporary-file replacement](https://github.com/microsoft/vscode/blob/a48dd23e2ac513740bd36066ae4de756337bba20/src/vs/platform/files/node/diskFileSystemProvider.ts#L291-L324).
The content-hash check detects same-length edits as well.

The host retains the opened checkout's directory descriptor and rejects a
replaced root. The bundled helper uses macOS `openat`, `renameatx_np` and
`unlinkat` with kernel-enforced no-symlink and beneath-checkout resolution.
Git starts from that same directory descriptor with an explicit work-tree scope,
so an external `core.worktree` configuration change cannot redirect it.
A last-moment parent symlink
cannot redirect reads, staging, replacement or cleanup outside the checkout.
Mode, ACLs and extended attributes are copied to staged files; saving hard-linked
files is refused with an explanation. Service tests cover mode/xattr preservation,
hard-link refusal, root replacement, symlinks, special files, bounded reads,
replacement errors, temporary-name collisions, partial staging failures and cleanup.
Native APIs are verified on the test host above;
other macOS releases remain unverified and unsupported operations fail closed.
No VoiceOver/manual accessibility certification is claimed.

Latest validation: TypeScript, lint, all 16 host tests, native compiler warnings
and static analysis, production build, macOS packaging, packaged tool discovery,
and both packaged/unpackaged editor workflows passed. The packaged workflows
run with `PATH=/usr/bin:/bin`. The aggregate `bun run smoke` also attempted the
development hot-reload check, which could not bind port 5173 because an existing
development server was using it; that server was left running.

## Current-checkout chats (2026-10-29)

The chat adapter supports installed Codex **0.165.0**, using one app-owned
`app-server --listen stdio://` process per connected chat. Protocol fields were
checked against `codex app-server generate-ts` from that exact build and the
[official app-server documentation](https://learn.chatgpt.com/docs/app-server).
No configuration is rewritten: thread start/resume supply only checkout/thread
identity and history hydration options. Displayed model, reasoning, approval and
sandbox values come from the actual start/resume response, including defaults.

Live authenticated checks on the development host established streamed text,
completed turns, effective settings and saved history through a fresh app-server.
Additional live checks interrupted a running `sleep 60` command, retained a
completed bounded file write after Stop, and reopened history with no active turn
and no continuation message sent. An empty-chat reconnect exposed Codex's lack
of a saved rollout before the first turn; never-sent chats now receive a fresh
empty provider thread, while a recorded send attempt always requires resume of
the original provider thread. These checks used
a temporary checkout with effective read-only sandbox and on-request approval.
They do not establish all possible permission profiles or arbitrary CLI versions.

Controlled protocol tests exercise two chats, duplicate-turn rejection, scoped
Stop, command approval, input answers, one-use responses, wrong-chat/thread
rejection, disconnection invalidation, explicit reconnect without resend, failed
authentication and retained drafts. The opt-in Electron chat test exercises
create/send/stream, view navigation, draft retention and fresh-connection history.
File/permission approvals and MCP/input prompts are represented by
controlled events; no claim of exhaustive live approval-policy coverage is made.

Associations/drafts use serialized atomic JSON replacement in Electron user data
(mode 0600), with Codex as the history source. This is not a crash-durability or
full workspace-recovery guarantee. Losing a connection clears live requests and
active state; retry starts a new connection and reads history, never resubmits
work. If a turn's send result is uncertain, its draft remains available for the
user to inspect against history before sending again. Missing tools, unsupported
versions and authentication failures leave saved associations/drafts intact.

This slice provides current-checkout chats only. Close/quit confirmations,
workspace restoration and managed worktrees remain subsequent tickets. App quit
ends app-owned connections; agents are not designed to survive app exit.


## Concurrent navigation (2026-10-29)

Project tabs use the repository's canonical primary checkout identity from Git
worktree metadata. Opening a linked checkout focuses the same project tab.
Branch switches leave saved chat associations intact. Host operations carry an
explicit checkout or project/chat identity; another project's checkout cannot be
used when creating a chat. Per-checkout Monaco models and selections remain
mounted while navigating, as do each project's chat selection and drafts.
Background polling updates activity indicators without selecting a tab or chat.

The opt-in live host test ran four installed Codex 0.165.0 chats: two sharing a
checkout, one in a linked worktree, and one in a second repository. It interrupted
one chat after a command began and verified independent completion of the other
three. The controlled Electron concurrency test uses separate stdio processes to
exercise background approval indicators without focus changes, exact response
routing, independent Stop, connection failure and rejection of stale requests.
These controlled approvals do not establish every live permission profile.

Navigation tests use real Git repositories and a linked worktree, retain dirty
buffers and saved message drafts, reject a cross-project checkout, and verify
repository-tab deduplication and chat retention after a branch switch. Project
mode, checkout context, file/diff and chat selections are held for this app
session. Full restart restoration, managed-worktree controls, crash recovery,
close/quit protection and manual VoiceOver validation remain subsequent work.

Validation passed: TypeScript, lint, host tests, production build, macOS packaging,
and all six non-development Electron checks with live Codex chat enabled. The
concurrency regression also delays chat creation and reconnection while the user
selects another chat, preserving selection, checkout context and draft. Legacy
worktree association migration preserves saved IDs, threads and drafts. Making
one checkout unavailable does not block another project's chat controls.
The aggregate smoke command still fails its development hot-reload check because
port 5173 is occupied by an existing server; that server was left running.


## Worktree creation and explicit reuse (2026-10-29)

Chat creation offers current-checkout use, a new managed worktree and explicit reuse
of a project checkout discovered by `git worktree list --porcelain -z`. Bases are
local branches, HEAD and a locally recorded origin default when available. No
network lookup occurs. The origin default's local branch is preferred; HEAD is the
fallback without usable default metadata. The displayed commit is checked again
before creation; a moved or missing base requires refreshing and choosing again.
Empty repositories require an external first commit.

Managed paths use the canonical repository identity's SHA-256 hash and an exclusive
random container under Electron user data. Git creates a unique escode branch at the
chosen commit, with Git hooks disabled for this operation. No files are copied from
the original checkout, no setup runs and no chat is created before Git succeeds.
Failures preserve and report possible branch/directory leftovers. Retrying reserves
a fresh container; there is no automatic cleanup or branch deletion. Existing
worktrees are never silently substituted. Creation results remain visible and
copyable, including when subsequent chat connection fails.

Real-repository host tests cover staged/unstaged/untracked/ignored preservation,
resolved commits, missing/moved bases, empty repositories, same-name repositories,
separate-process concurrent creation, occupied empty/nonempty destinations and a lost
result after successful Git creation. Changed Git-directory pointers are rejected
before allocation; mutation uses the validated Git directory explicitly. Canonical
managed paths inside any registered project checkout, including symlink aliases,
are rejected with external user-data-directory guidance. An externally deleted sibling
worktree does not block creation from a healthy checkout or prune its registration. Creation errors and
copyable leftover identities remain visible across retries until dismissed. The Electron workflow creates a worktree from dirty disk, preserves an
unsaved Monaco buffer in the original checkout, reuses the new checkout explicitly,
shows the shared-files notice and retains an existing message draft. A required
Git checkout filter forces a real partial failure; a successful retry retains the
earlier result and recovery instructions and never starts a chat for the failed attempt. No Codex turn
is sent by this test. Typecheck, lint, host tests, build and the targeted Electron
workflow passed. Full restart restoration, protected worktree removal, manual
VoiceOver checks and a live agent turn on a newly managed checkout remain outside
this ticket's runtime evidence.


## Codex version ranges (2026-10-29)

The exact 0.165.0 lock has been replaced by a stable-version minimum, keeping the
tested baseline separate. Controlled subprocess tests cover minimum/newer versions,
numeric ordering, old/unknown/prerelease rejection before startup, malformed
initialization, and diagnostics after a failed probe. Existing chat validation still
checks checkout, effective settings and resumed thread identity; version admission
never bypasses those checks.

The demo failure selected `/opt/homebrew/bin/codex` (0.163.0), while the shell used
`~/.bun/bin/codex` (0.165.0). Both are retained; escode does not install/update Codex
or change PATH. The implementation keeps the existing installed-tool architecture.

Live Electron checks passed on both installed 0.163.0 and 0.165.0: create, send,
stream, complete, reconnect, reload saved history and preserve an unsent draft.
These checks consumed bounded text-only turns. The test checks user/assistant
message counts rather than assuming there can be no additional activity items.
Select an installation for this check with `ESCODE_TEST_CODEX_DIR=/opt/homebrew/bin`
and `ESCODE_LIVE_CHAT=1` when running `bun run --cwd apps/desktop smoke -- tests/chat.spec.ts`.
Future releases are admitted by version and checked at runtime, not pre-certified.

## [Recover unsaved work and close or restart predictably](https://github.com/ejjsharpe/escode/issues/17)

`workspace.json` in Electron user data contains project tab order, selection,
per-project mode/checkout/chat, per-checkout file/directory/diff selection and
unsaved buffers with their loaded disk baselines. Saved chats and message drafts
remain in `chats.json`; Codex owns conversation history. Restart may connect to
load the selected saved history, but never sends a turn. Missing original
checkouts report an error and retain their persisted entries/drafts for retry by
reopening the project. Invalid workspace data blocks startup without overwriting it.

Recovery writes are serialized, replace the file atomically and sync the temporary
file and containing directory before acknowledgement. Each content change queues
a snapshot without a debounce. A crash before IPC delivery or acknowledgement can
lose recent edits; power-loss durability and arbitrary storage failures are not
guaranteed. Recovery data contains source text and is stored with private file
permissions under the user's account. Explicit discard waits for removal of the
durable draft before closing the buffer. Restored drafts retain the original disk
baseline, so an external edit still triggers ordinary Compare/Overwrite/Reload.

`tests/lifecycle.spec.ts` hard-kills the real Electron host with SIGKILL after the
workspace draft appears on disk, changes the source externally, relaunches with
the same user-data directory, checks recovery/conflict, cancels project close,
fails a close-save with a deleted file, and verifies explicit discard stays gone
through restart. It also verifies remembered mode. This establishes recovery of
an available persisted draft on this filesystem; it does not establish recovery
of an unacknowledged keystroke or a machine power failure.

`host/shutdown.test.ts` uses real protocol fixture processes and descendants,
including a child that ignores SIGTERM. Project shutdown requests turn interruption,
invalidates live requests and connections, terminates its private process groups,
then escalates to SIGKILL after 300 ms. Other projects remain usable. App quit
applies this to all connected chats. Saved chats, branches and worktrees are
retained. Descendants that deliberately escape the owned process group (daemonize
into a new session) are outside this process-group lifetime guarantee.

The shutdown regressions also cover a connection still opening and a failed
initialize response: both wait for descendant cleanup before quit can complete.
The Electron lifecycle smoke checks active-work cancellation, interruption on quit,
process exit and reopening saved history without another turn. Restart checks
include the selected file, mode and Git diff. These results supersede the earlier
slices' close/restart/recovery deferrals above.

Validation on 2026-10-29: typecheck, lint, full host suite, build and packaging
passed. Electron smoke checks passed with the StyleX development test excluded;
its required port 5173 was already occupied. The live Codex smoke remains opt-in
and was not run for this slice; protocol fixtures exercise real child processes.

Lifecycle race regressions additionally delay saved-chat metadata reads before
connection setup. The host rejects requests whose project closed during IPC
validation, and ChatService registers an opening before reading its saved
association so shutdown can invalidate and await it before any process starts.
File close locks editing and duplicate close actions until draft invalidation
finishes; `tests/lifecycle-races.spec.ts` delays the actual filesystem replacement
and attempts input during clean close and Discard, then checks that no draft is
resurrected. Failed close unlocks the editor and retains its draft.

The active-project smoke also confirms Stop and Close with dirty files: cancellation
at the dirty prompt leaves work running; confirmation saves the file, interrupts
and terminates processes, and retains saved chats, a managed worktree and its
branch. Reopening the project restores the saved chat and worktree draft without
sending another turn.

The crash/restart smoke now opens two projects and verifies their tab order,
selected project, recovered file and independent remembered Git diff selections
through a hard kill and subsequent graceful restart.

Managed worktree removal uses persisted app ownership and checkout directory identity.
The host confirms the path, retained branch and linked chats, blocks active work and
recovery drafts, and rechecks Git status including ignored files. Hidden index entries
and submodules are treated as uncertain and block removal. Git removal never uses
force. Failures retain ownership records for inspection and retry; no branch or
uncertain leftover directory is cleaned up automatically. Older worktrees without
ownership records require external management.

The worktree host regressions cover dirty tracked/untracked/ignored files introduced
after inspection, changed branches, hidden index entries, locked-worktree failure
and retry, external-worktree rejection, and branch/commit retention. The Electron
workflow checks confirmed removal, recovery-draft blocking and unavailable linked
chats with their message drafts retained. Protocol fixtures check active-chat
identification and that removed chats cannot reconnect or send.


On 2026-10-29 the user chose VS Code's removal policy for the reproduced late-file
race. VS Code delegates ordinary removal to `git worktree remove`; see its
[pinned Git implementation](https://github.com/microsoft/vscode/blob/fc8954c90fe6dea1f4c411dd73fdfe5f1913b5ca/extensions/git/src/git.ts#L2327-L2335)
and [worktree removal documentation](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees#remove-a-worktree).
The escode prechecks still block existing ignored files and never offer force.
They do not make deletion transactional: an unrelated process can write after the
last check, and Git can delete a late ignored file. A regression injects an ignored
file immediately after the final check and records this accepted limitation.
No recoverable removal backup is made.

Review fixes persist every linked chat's unavailable intent before deleting files,
and disconnect all linked sessions even when storing intent fails (which blocks
deletion). Retry can finish a missing-but-registered owned checkout after checking
its retained branch and commit. Creating a new worktree uses the primary project
checkout even when the selected chat remains attached to a removed checkout.


The first Files rename/move and native Trash preservation gate has separate
[compatibility and recovery evidence](file-operations.md), including its disclosed
Monaco earlier-undo reset and native/manual verification limits.
