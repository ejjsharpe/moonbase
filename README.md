# Moonbase

A fresh project for an independent editor and Pi Durable chat modules, retaining Nx, Bun, Electron, React, TypeScript, Monaco, StyleX, Base UI and Effect.

The foundation defines the shared browser-safe editor interface, Effect service/command handlers, pinned tooling, shared UI recipes and a provenance-checked immutable editor reference. It does not yet provide a desktop application.

The brief requires one shared Effect application command center, with focused module services and one runtime per process. The architecture and task ownership are defined in `docs/agents/prompts/OVERNIGHT.txt`.

Read [MODULES.md](MODULES.md) for boundaries and acceptance, [DESIGN.md](DESIGN.md) for UI rules and [the delivery ledger](docs/overnight/ledger.md) for exact PR dependencies and evidence. Run `bun install --frozen-lockfile`, `bun run check:foundation`, `bun run typecheck`, `bun run lint` and `bun run test` for bootstrap checks. At this stage lint is an explicit TypeScript diagnostic check, not a separate style-lint qualification. Public command-client tests establish runtime sharing, cancellation, errors and disposal only.

T3 Code is development tooling only. The brief excludes T3/Pocket/Codex application-code reuse, checks provenance before retaining your editor code, and keeps required notices for Pi Durable and the actual stack/dependencies.

## Start the overnight run

Open this checkout as the **Moonbase** project in T3 Code, start a new chat there, and send:

> Read `docs/agents/prompts/OVERNIGHT.txt` and run the overnight task described there.

The prompt is self-contained and authorizes the lead to prepare focused pull requests in the private `ejjsharpe/moonbase` repository, using parallel workers and independent review. It preserves the original escode checkout and leaves GitHub PRs for human review. Keep the executing machine and session running.

Source reference: `/Users/elliotsharpe/Projects/escode`. Do not modify or import that repository's Git history.
