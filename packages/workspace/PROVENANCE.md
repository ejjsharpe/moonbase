# Workspace source provenance

The immutable source snapshot at `docs/source-snapshot` revision `181097195a026d48b82758cee841ed8dd326db70` is the only escode source consulted. Its manifest records Elliot Sharpe implementation history and attribution inspection for these files. The live escode checkout and its tracker were not accessed or changed.

| Frozen source | SHA-256 | Active use |
| --- | --- | --- |
| `apps/desktop/host/filesystem.c` | `5d9a9b2e5fc68dc46ae1c4aad65469c59042753b37cf0d512f45a380dd636297` | `native/filesystem.c`: retained descriptor-scoped macOS implementation; added bounded native preflight/copy, atomic initial text creation, case collision check, and staged-save identity publication/revalidation. |
| `apps/desktop/host/native-import.ts` | `86b14a116a07cdfe6877222fde3bbe618eb8d002bca673e34ba1a42550b673b4` | `src/native-import.ts`: retained no-follow native source/ancestor capture; parameter properties expanded for Node strip-types. |
| `apps/desktop/host/native-races.test.ts` | `1e2b021e142c9530a147995e2f3777e48d0fdbc6feacfad2e6cf13ea359f6d56` | `test/native-races.test.ts`: retained deterministic preflight/staging race scenarios; changed runner/assertion harness and paths only. |

`project.ts`, `checkout-repository.ts`, `file-operations.ts`, `file-operation-journal.ts`, `file-operation-state.ts`, `workspace.ts`, their frozen safety tests, and compatibility/specification documents were inspected as behavioral references. Node no-follow flags, descriptor inheritance, content hashing and Git invocation follow the verified user-authored filesystem policy; no original contract, provider, database, transport or executable-discovery module was imported. The active independent SQLite schema and application-service implementation are new Moonbase code. No source checkout/worktree-management operations are retained.

`src/lookup.ts` is independently authored from the required matching/highlight behavior. The excluded Microsoft/VS Code scorer was neither read nor copied. No T3, Pocket, Codex or Microsoft application helpers, schemas, fixtures or vendored application code are included.

The module adds no third-party JavaScript dependency beyond the pinned existing Effect stack and application contracts. Native code uses macOS SDK APIs; Git and standalone ripgrep are privileged executable dependencies selected by the composition root. The final run used the coordinator-provided official ripgrep 15.2.0 release executable, not a Codex installation path. This branch contains no copied executable or manually assembled license bundle. Keep normal notices supplied by installed/shipped dependencies and produce artifact notice qualification in the coordinator-owned packaging work. This provenance record is not a claim that an assembled desktop distribution has been licensed or packaged.
