# Overnight delivery ledger

## Setup

- Private target: `ejjsharpe/moonbase`; existing documentation-only main preserved at `c89e4db`.
- Lead T3 binding: Moonbase, dedicated `chore/module-foundation` worktree; source escode is reference-only.
- Live models verified: codex `gpt-6.1-sol` implementation and `gpt-6-astra` review, both support explicit `reasoningEffort: xhigh`; service tier `default`.
- Source: `181097195a026d48b82758cee841ed8dd326db70` plus hashed working-tree editor/UI changes. Forty selected reference files, exclusions and histories are in `docs/source-snapshot/manifest.json`.
- Frozen public editor contracts and focused workspace service are in `packages/application`; initial public-client checks cover shared acquisition/disposal, typed failures, subscription disposal and cancellation without blocking unrelated commands.
- Bootstrap checks do not establish editor acceptance. No app placeholder is presented as a runnable editor.
- Foundation PR: https://github.com/ejjsharpe/moonbase/pull/1, head `bb5c5d0b366f43e5406fc328d5bd5ec7ee154e58`, base main `c89e4db`. GitHub macOS checks passed at this exact head (runs 41258433992 and 41258434814).
- Parallel Sol `xhigh` workers: `feat/editor-module` and `feat/workspace-module`, exact foundation verified; independent Astra `xhigh` foundation review running. Task IDs/options are persisted in `tasks.json`.
- Dependency notices remain with installed packages and release assets. Per the user's follow-up, manually copied license bundles are removed from source; packaging will include required package-provided notices in generated output.
- Editor worker identified missing checkout binding in recovered operation evidence. Coordinator added mandatory `OperationResult.checkout` centrally; workspace journal/recovery and editor reconciliation must preserve it. Both workers consume the committed shared-contract follow-up and keep missing/unbound evidence visible instead of guessing.
- Astra foundation review at `bb5c5d0` reported the same P1 identity gap plus two P2 runtime errors (hidden finalizer failures and untyped cancellation). PR #2 fixes all three; six public-client regression tests pass after three expected failing regression paths were reproduced. Full findings/responses are in `reviews/foundation-r1.md`; a fresh independent changed-head review follows.
- Round 2 at `a77b241` found a pinned-Effect pending-acquisition cleanup race, throwing arbitrary-defect formatting and inherited pre-aborted dispatch. All were reproduced and repaired centrally; ten public-client tests now pass, and both feature owners have the required enclosing-scope watch convention. See `reviews/boundary-r2.md`.
- Round 3 at `bfbd704` found combined service/finalizer errors converted to Die reasons, losing typed uncertainty and target. The adapter now recognizes genuine privately branded application errors safely in either reason kind; twelve public-client tests cover both command/subscription combinations. See `reviews/boundary-r3.md`.
- Round 4 at `47d6e6b` approved shared-contract coherence but found arbitrary cleanup proxies could lose the original failure inside pinned Effect. External releases now normalize errors through `releaseResource`; fourteen public-client tests cover both synchronous/async cleanup combinations. Real module owners must use the documented boundary. See `reviews/boundary-r4.md`.
- Round 5 independently reviewed PR #2 at `68aa035b9c283a65cac6e78ab02865e99882d15b` against foundation `8ef20b06222db32b54b4bdf9e6c2223a1ebd4da4`: **no blocking findings**,14 committed tests and56 extra public-boundary checks passed, exact-head GitHub checks passed. Boundary is technically sound; actual module adoption/fan-in remains pending. See `reviews/boundary-r5.md`.
- Real module integration exposed global acknowledgement/implicit revision gaps. Receipts now carry origin-client identity and exact recovery revision changes; acknowledgement is per observer. Clients reconcile only known contiguous transitions and retain ordinary CAS conflicts. Saves preserve other clients' dirty baselines.
- Lookup contract now includes ranked matches, highlight positions and separately filtered scoped history. Workspace owner is using the verified standalone ripgrep 15.2.0 asset for full local/nested ignore policy and independent matching/ranking.
- Standalone macOS arm64 ripgrep matches its official GitHub release digest, executes independently and links only system libraries. Keep asset provenance in this ledger; packaging carries the dependency's supplied notices automatically. Final packaged artifact/target closure remains a packaging gate.

## Planned dependency order

1. Foundation PR, exact committed base for editor/workspace siblings.
2. Editor and workspace focused PRs; independent Astra reviews and owner fixes.
3. Non-default reviewed fan-in and standalone packaged editor proof. Human acceptance PENDING.
4. Stable centralized chat/connection contracts; independent Pi Durable and SSH PRs, reviews/fixes.
5. Reviewed chat fan-in and standalone chat proof. Real-provider/remote checks only when explicitly authorized/configured.
6. Technically gated composition draft; morning handoff with exact heads, bases and evidence.

## Pending checks and constraints

No explicit real-provider quota authorization or SSH test host has been supplied. Real-provider/SSH smoke, native Finder/Trash, VoiceOver, human visual acceptance and power-loss qualification are not claimed. Continue controlled independent checks without changing those gates. No PR merges, deployment or source-checkout modifications are authorized.
