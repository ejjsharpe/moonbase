# Working on Moonbase

Read the root README and the README of each module you change. Keep READMEs and agent instructions at their entry points; put supporting documentation in the owning app/package’s `docs/` folder, or root `docs/` for repository-wide guidance. For UI work, also read [DESIGN.md](docs/DESIGN.md).

## Modular design

- Build reusable modules that can serve multiple clients. Packages own domain behavior; applications compose packages and supply platform integration, configuration and lifecycle.
- Give each module a focused public interface that hides its implementation. Consume other modules through public exports. Keep domain rules in their owning module rather than duplicating them in UI, IPC or transport adapters.
- Inject capabilities and dependencies. A module must be usable without importing a particular app, Electron shell or unrelated feature. Standalone editor and chat compositions install only their own capabilities.
- Keep changes within scope. Reuse existing modules before adding abstractions; add flexibility only for a concrete consumer. Update affected public callers, tests and documentation together.

## Runtime boundaries

`packages/application` is the shared Effect command center: typed commands, queries, subscriptions, dispatch, cancellation, errors and dependency composition. UI, keyboard, native and transport entry points use the same handlers.

Workspace, Pi and SSH expose focused Effect services/layers with injected dependencies and own their validation, resources and domain rules. Each process creates one scoped root runtime and acquires shared dependencies once; feature packages return Effects/scoped streams. React receives browser-safe clients. Buffers, rendering and pure editor calculations stay ordinary TypeScript. Pi Durable owns execution, transcripts and tasks. Use resource-appropriate concurrency so long work cannot block unrelated commands or Stop; keep the center small without another scheduler, event store or global command queue.

## Verification and safety

Test nontrivial behavior through public interfaces, including loss/conflict/uncertainty, disposal and exact local/remote identities. Distinguish source checks, controlled integration, packaged execution and real/manual checks. Preserve dirty work, trust-boundary validation, required notices and observable errors.

Use `packages/ui` StyleX tokens/recipes and Base UI interactions. Keep PRs focused on module boundaries, fix issues in their owning module and link PRs with T3 when available.

No legacy-state import or deletion, real-provider quota without explicit authorization, unspecified SSH host, host-key bypass, deployment or GitHub PR merges.
