# Pi runtime provenance and runtime inputs

Moonbase code, HTTP authentication, projections, CLI, example and controlled fixtures in this package were independently authored for this task. No escode, Pi Pocket, T3, Codex, Microsoft or old host application implementation/helper/schema was selected or copied. The first-party committed `docs/research/pi-durable-v0-contract-evidence.md` and its two public-API probes were read as feasibility evidence; this package has its own public tests. The research-only coordinator base is `7bfc7764b8950f93ee8fd41cc8ca86914b434f86`, above chat contract `d38833db81c5d97a1aa60f25e0dc27dd670af60f`.

Normal dependencies are `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord` **1.4.0**, Effect **4.1.0** and the application workspace package. Test schemas use TypeBox **1.3.27**. The supplied temporary research installation was read for API inspection only; no legacy state, application source or dependency directory was transplanted. Local links were installed with `bun install --no-save`; coordinator owns the final root lockfile registration.

Re-fetched [published Durable 1.4.0 metadata/tarball](https://registry.npmjs.org/@earendil-works/pi-durable/1.4.0) and verified the 801,973-byte archive against both registry integrity and the agreed SHA-512:

```text
sha512-EtIyXH1MBSXdJSkodmy+CYXuwfve3gPrD4GNCZ0XmuRWLPupwRlNQ7fdaXjRcLoKb6SWkT/yEzK+sMmrqvYK+Q==
```

Inspected the published installed README, declarations and JavaScript for Harness/Session lifetime, ordinary admission, public `submissionByRequest`, documents/creation/configure, abort/join/handover, entry/task scans, commit invalidation, Node SQLite ownership and provider credential/catalog facilities. This release is the API authority; neither the earlier `8ffea8a` source nor later main API was substituted. Durable/AI/Chord manifests all record MIT and Node >=22.19.0. **Node 22 is unqualified here**; host code/CLI is qualified on Node 26.13.0/macOS arm64 and declares >=26.13.0. The separate compiled remote graph passes Electron 45.1.0's Node 24.22.1 and imports no engine/SQLite/provider implementation.

Selected provider factories use their normal package assets:

| Asset under `@earendil-works/pi-ai/dist/providers/data/` | Bytes | SHA-256 |
| --- | ---: | --- |
| `openai.json` | 28,138 | `cf5e119eb05f47bbf1dbad179de6a07b904bf7673e96691be72ab0b1fe40a781` |
| `anthropic.json` | 11,820 | `91f5da01452c7746645d3405bc91e09f849e4e4687c7c7ff22d8976eafe64b87` |

The source-mode standalone host needs Node's built-in SQLite, the normal installed package trees/provider catalogs and host shell/filesystem facilities for selected coding tools. Real CLI startup resolves the production factories/catalog/auth facilities with provider networking blocked. Controlled faux runs exercise Pi persistence/execution and actual coding-tool Bash/Node environment. QuickJS/codemode, photon image processing and their optional worker/WASM engines are not selected or qualified. Their transitive presence in the normal dependency installation does not mean their initialization or packaging passed.

No Moonbase native binary, manual license bundle or copied dependency source is added. Durable/AI/Chord manifests declare MIT, but a recursive filename audit of these three installed packages found no LICENSE/NOTICE files. This does not qualify distribution notices. Packaging must resolve and retain the actual required upstream copyright/license text and runtime files for its shipped graph; automatic final package/notice generation belongs to the coordinator. No notice was removed or manufactured here. The in-memory remote bundle audit and source CLI execution are not a signed/distributed artifact qualification. A blocked `electron-winstaller` install script was observed during link installation; this macOS host/remote test does not select Windows packaging and no untrusted lifecycle script was enabled.
