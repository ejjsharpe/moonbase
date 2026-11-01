# Review R7 correction

Reviewed head: `914455852dcf0e700397adb3facb9daa0d7e0514`. Exact base remains `8557fdd0d7a71f93a6584c77430e6fde57668580` (`chore/recovery-publication-contract`, #7). Executable/test source: `836b843ff70f6219c63788ab277d4d15525974cb`. The next evidence-only commit records these checks, README links and inspected PNGs. PR #4 remains **DRAFT** for fresh independent R8; stack #1 → #2 → #5 → #7 → #4 is unchanged.

This round authors only `packages/editor`. No shared contract, root, sibling, dependency, export, runtime, queue or filesystem authority changed. Connection/SSH work remains separate and was not imported or merged.

## P2 settled comparison suppresses a recreated working buffer

Readiness now checks the actual working-buffer requirement as well as the settled view. A comparison that gains an available working document while its editor buffer is absent goes through the existing guarded Open path. The selected-checkout Refresh path uses the same activation when its successful read reveals that document; checkout return also activates it. A failed activation settles for the working version it attempted, so selection/preservation release does not repeatedly retry unchanged failures. New observed availability/version and explicit Open/Refresh can recover. Empty originals and still-missing working files remain valid settled comparison states.

The change reuses the existing current-selection, generation, preservation and exact-target guards. Existing dirty buffers retain their text and baseline; refreshing a newer external working version does not reset them. No stale result is given new authority, and no application runtime or contract is introduced.

Public regressions start with HEAD/index a.ts but no working file. Both staged and unstaged cases switch checkout, recreate the file through the public service, refresh and return; they then edit and Save through the public controller and verify the service's actual contents. Additional controls cover repeated missing/error settlement, a failed activation against the same observed version, a newly observed version becoming editable, empty untracked originals, dirty baseline/conflict retention, and selected-checkout Refresh without a checkout switch. Both browser journeys verify disabled Save before recreation, enabled Save afterward, readonly original/editable modified inputs, actual keyboard typing and a successful Save.

## Validation

- Before the fix, both staged/unstaged public and corrected browser causal cases fail: the comparison has the recreated document but the buffer remains absent and Save disabled. The selected-checkout Refresh probes also fail before their shared-path correction. Persistent-missing/version/error and empty-original controls pass with the fix.
- An initial browser precondition assumed Monaco's internal readonly setting implied `textarea.readOnly=true` for the missing modified pane. That precondition was corrected to visible comparison/disabled Save before counting causal evidence; both unchanged-controller reruns then fail on the reported disabled Save after recreation.
- **82/82 public editor tests**, **14/14 application tests**, **24/24 actual Chromium journeys**, no skips. Earlier R1–R6 Copy lifecycle, dirty restored views, observation/Reload, pending-close, receipt/observer/CAS, cancellation, preview/order/reopen, lookup/tree, typing and disposal cases remain represented.
- `bun install --frozen-lockfile`: 486 installs/619 packages checked, no changes.
- `NX_DAEMON=false bun x nx run-many -t typecheck lint test --skip-nx-cache`: all six tasks pass, cache skipped. Lint is TypeScript diagnostics. Direct public suite reports 82 passing cases.
- `bun run check:foundation`: 40 immutable source hashes/UI/browser-client checks pass.
- `bun run --cwd packages/editor check:renderer`: 1,569 browser inputs, no privileged module or feature runtime.
- `bun run --cwd packages/editor build`: StyleX, Monaco font and five workers pass. Existing >500 kB chunk warning remains; performance/startup qualification is unrun.
- Impeccable static detector on unchanged workbench/Monaco surfaces returns `[]`; whitespace passes. Browser runners were sequential; the full run reports **24/24** in 54.2 seconds.

## Inspected captures and remaining gates

[recreated-staged.png](recreated-staged.png) and [recreated-unstaged.png](recreated-unstaged.png) were opened for inspection at **1600×1000 CSS px**. They show the readonly `HEAD A` / `INDEX A` originals, actual typed modified text containing `RECREATED WORKING FILE`, enabled Save and the clean saved state after Save. Dataset: two volatile roots; alpha initially lacks working a.ts while retaining its declared HEAD/index data. `demo/recovery-race.tsx?missing=staged` / `?missing=unstaged` recreates the working file through the public workspace service.

Fresh independent R8, actual controller/production-workspace filesystem/Git/SQLite fan-in, native picker/drop/Trash, packaged Electron/signing, complete-app accessibility/VoiceOver and human acceptance remain **PENDING**. No composition was dispatched. Controlled memory/Chromium success does not establish production durability, IPC/power-loss exactly-once behavior or native acceptance. No provider quota, SSH, legacy state, deployment, children, PR merge/watch/poll or history rewrite was used.
