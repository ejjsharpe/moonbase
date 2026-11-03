# Local agents verification (#91)

This records the implementation in the worktree based on `94850e015ed8f2b760ea5258eb27b64ccbdd6b04`, including integrated #84/#90 and #92. Checks use macOS arm64, Node 26.13.0, Bun 1.4.4, Electron 45.1.0 and embedded Node 24.22.1 without dependency upgrades. Generated logs live in ignored root `test-results/local-91/` and desktop/workbench `test-results/` folders.

The implementation discussion selected the pinned SDK's newer OpenAI **Sign in with ChatGPT** browser callback/full redirect-URL fallback. It replaces the ticket's original legacy Codex/device-code choice. The separate OpenAI API-key provider retains independent credentials and conversation model identities.

## Source and controlled checks

- Frozen dependency installation passed without lockfile changes.
- Contracts: 61 tests passed, including strict local/settings/setup boundaries and private-field projection.
- Application: 272 tests passed, including named-target preservation/cleanup, local readiness, final Quit fencing, stale setup replies and setup cleanup errors.
- Desktop source: 31 tests passed, including exact committed Create recovery after folder loss/restart and continued rejection of new unapproved creation.
- Pi runtime: all 97 tests passed. Focused review regressions cover Send metadata preflight, cancelled Create waits, exact Create recovery, failed setup ownership transfer and SDK refresh with encrypted storage.
- Controlled SSH/HTTP/SQLite chat integration: 7 tests passed with no real host or provider.
- Foundation, repository typecheck, lint, formatting and `git diff --check` passed. The foundation audit retains unchanged baseline-produced remote saved/protocol bytes.
- Actual desktop and workbench renderer graph audits passed. Main includes the intended privileged local runtime; renderer/preload exclude SDK, credentials and SQLite.
- The production local layer/catalog was bundled and executed under pinned Electron with `PATH=/usr/bin:/bin`, provider network disabled and no system Node. It executed a coding tool, retained the standalone Node guard and loaded current ChatGPT OAuth through callback setup/cancellation.
- The pinned SDK was tested with encrypted private files: concurrent refresh, caller cancellation after refresh starts, persisted rotated token, retained `clientId`/`scopes`, provider/encryption failure preservation and independent API-key credentials. This uses a controlled provider refresh with no network.

## Browser, native and packaged checks

- Browser shell: all 13 tests passed.
- Workbench UI: all 48 tests passed.
- Native local UI: setup through two folder/model conversations, real coding-tool writes, streaming, hidden local work, Keep running/Quit and restart passed using network-disabled faux streams and an injected test cipher. Normal, constrained and 200% zoom screenshots were inspected. A narrow/zoomed viewport initially clipped the focused Stop button; the embedded view now uses its allocated panel and allows whole-surface scrolling with a minimum content height. Five consecutive targeted native zoom/keyboard checks passed after that correction, followed by the complete native suite.
- Native final suite: all 64 tests passed against the rebuilt app. It includes startup-failure local-work confirmation, obsolete native confirmation across document replacement and activity-scan failure during crash-Quit. Controlled active-status/error injection in those failure-view tests is separate from the actual task activity covered by the local runtime and main local journey.
- Desktop build and unsigned macOS package passed; archive graph/resources/notices checks passed. Missing release notices are pinned and checksum-verified, and fixture exclusions remain enforced.
- Packaged final suite: all 23 tests passed, including loading ChatGPT OAuth from ASAR with no system Node and cancelling before external sign-in or provider network access.

## Independent review

The requested review reproduced three issues: an uncounted Send metadata preflight at Quit, native approval blocking committed Create receipt recovery, and a new authentication flow surviving a failed status response. All three were corrected in their owning paths and covered by controlled regressions. It also requested the SDK/encrypted-refresh integration test described above. The focused second review found no remaining actionable findings and passed 19 focused checks. A subsequent review of the added native failure-view fallback found two more document/intent and crash-error races; those were fixed and covered by native regressions. The attempted final independent recheck hit the provider usage limit, so it did not qualify those last fixes. The final native suite does cover them.

## Remaining manual acceptance

No real provider quota, account sign-in/refresh, real SSH host, existing external credential file or legacy state was used. Actual safeStorage/Keychain prompts and persistence remain separate from the injected cipher tests. Manual OS picker/clipboard/drag gestures, VoiceOver, physical durability, Intel execution, signing/notarization and distribution remain unqualified.

Local tools have OS permissions; the working folder is not a sandbox. Quit does not roll back external effects. Restart follows Pi's saved-task recovery semantics. Existing remote settings, request/storage formats, draft key and remote-work lifetime are retained.
