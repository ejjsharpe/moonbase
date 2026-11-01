# Runnable review commands

All existing logs are immutable phase records. `probe.sh PHASE` chooses a new timestamped output name. It requires the documented build dependencies and an explicitly acquired exclusive foreground slot for native/browser cases. Foreground is released; do not run native cases merely to read this report. Public probes use fresh directories but currently write their JSON beside the script: copy their existing JSON first if rerunning them. Do not overwrite the retained original evidence.

From repository root, using pinned Bun1.4.4/Node26.13.0 (the exact paths are in probe.sh):

```sh
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
export MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg"
bun run check:foundation
NX_DAEMON=false bunx nx run-many -t typecheck lint test --skip-nx-cache --output-style=static
bun run test:editor-integration
bun run test:chat-integration
NX_DAEMON=false bunx nx run-many -t build --skip-nx-cache --output-style=static
bun run --cwd apps/desktop package
bun run --cwd apps/desktop check:renderer
node apps/desktop/scripts/check-package.mjs
node apps/desktop/test-results/review-task08-r1/audit.mjs
python3 apps/desktop/test-results/review-task08-r1/git-audit.py
```

The native build preparation uses `node packages/workspace/scripts/build-native.mjs`. The qualified rg path is supplied by scripts/prepare-ripgrep.mjs and the normal packaging inputs. Build/package logs retain the actual emitted paths. The packaged client itself uses only `/usr/bin:/bin`, no build Node/provider environment.

```sh
apps/desktop/test-results/review-task08-r1/probe.sh current-source
apps/desktop/test-results/review-task08-r1/probe.sh current-package
apps/desktop/test-results/review-task08-r1/probe.sh preserved-editor
apps/desktop/test-results/review-task08-r1/probe.sh preserved-package
apps/desktop/test-results/review-task08-r1/probe.sh chromium
apps/desktop/test-results/review-task08-r1/probe.sh public-real
apps/desktop/test-results/review-task08-r1/probe.sh fresh-public
```

Expected current results: source11/package10, preserved editor25/package1, Chromium35 PASS. Public-real and fresh-public PASS their documented observations; fresh-public explicitly asserts the reproduced loss and the flush control, not desired no-loss behavior.

```sh
apps/desktop/test-results/review-task08-r1/probe.sh supplementary-source
apps/desktop/test-results/review-task08-r1/probe.sh supplementary-package
apps/desktop/test-results/review-task08-r1/probe.sh fresh-current-source
apps/desktop/test-results/review-task08-r1/probe.sh fresh-current-package
apps/desktop/test-results/review-task08-r1/probe.sh config-source
apps/desktop/test-results/review-task08-r1/probe.sh config-package
```

Expected current findings: supplementary has1PASS/latest-chat gate and1RED/fresh-edit Reload. Timed fresh Reload has1RED. Config has1PASS/four invalid file inputs and1RED/present-empty value. Desired retention/config assertions remain failing until repaired; do not invert them to manufacture a green suite.

Historical products were freshly extracted with `git archive` into OWN ignored `old-cc06` and `standalone-4dd` directories, then installed frozen and built/packaged within those directories using the pinned tools. No old worktree or original checkout was executed. `source-artifact.json` verifies every selected source byte and package hash. To reconstruct in a NEW own empty archive directory, use:

```sh
# Set archive_dir to a NEW empty directory under this review's ignored evidence.
# Set archive_ref to exact cc06d753e76dc02470628a611a3a481f771953b9 or4dd148ade5f279e2b3820df0325313ee08ce4f8d.
mkdir "$archive_dir"
git archive "$archive_ref" | tar -x -C "$archive_dir"
(cd "$archive_dir" && bun install --frozen-lockfile)
(cd "$archive_dir" && node packages/workspace/scripts/build-native.mjs)
(cd "$archive_dir" && node scripts/prepare-ripgrep.mjs)
(cd "$archive_dir" && bun run --cwd apps/desktop package)
```

The preserved historical directories are already built. Exact same current final drivers target those binaries through supported test-main/executable overrides:

```sh
apps/desktop/test-results/review-task08-r1/probe.sh historical-source
apps/desktop/test-results/review-task08-r1/probe.sh historical-package
apps/desktop/test-results/review-task08-r1/probe.sh fresh-4dd-source
apps/desktop/test-results/review-task08-r1/probe.sh fresh-4dd-package
```

Historical source/package each produce two intended failures (keyboard focus and committed-unload cancellation).4dd timed Reload each produces one intended loss failure. The old original cc06 asar remains unavailable; these are fresh reconstructions.

Headless final audits:

```sh
python3 apps/desktop/test-results/review-task08-r1/artifacts.py

# Only while you own foreground and after all your phases finish:
python3 apps/desktop/test-results/review-task08-r1/cleanup-audit.py
git diff --check
git status --short
git rev-parse HEAD
```

`run-phase.py` logs each execution and samples owned descendants/groups, then verifies recorded process absence. Fixture close routines record exact host/forward PIDs/groups and port rebounds. `cleanup-audit.py` rechecks those records, including short-lived config processes, and only tests exact recorded temporary-directory absence. It never scans/deletes Trash or sends cleanup signals. After any future run, extend the audit for any new phase naming/output before claiming full cleanup.
