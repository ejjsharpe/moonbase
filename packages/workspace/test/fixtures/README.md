# Previous public producer

`workspace-53a0996.tar.gz` contains the six unmodified `packages/workspace/src/*.ts` files from this private Moonbase repository at `53a0996494edc633d562c980f02ea4b8bd1dad92`. It was produced with `git archive` and gzip; every extracted file was byte-compared with `git show` at that exact commit. Archive SHA-256: `4b9e54649f195a18e8d93502f86bf21ba12e070c10261aa47a61d6f6b8aa510b`.

The public regression test verifies that checksum, extracts into ignored `dist/previous-workspace`, and invokes the actual previous `WorkspaceLive` through the shared application client. It generates fresh isolated stores with real files/Git/SQLite, then restarts them with the current service. No database records are edited. Keeping this bounded source fixture makes the tests independent of Git history depth or network access in CI.

This is first-party Moonbase implementation, including the already qualified native-import helper described in the module's provenance record. It adds no vendored application helper, provider, native executable, native source, new dependency or manual notice bundle. The same explicit production filesystem helper is injected into both producers; its source and hash are unchanged. The previous service is a test data producer only, never a production compatibility runtime or legacy escode importer.
