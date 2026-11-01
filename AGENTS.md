# Working on Moonbase

Read `README.md` and the relevant package README before implementation.

For UI changes, use `packages/ui` StyleX tokens/recipes and Base UI interactions.

Keep changes within the requested scope and consume other modules through their public exports.

One shared Effect command center in `packages/application` owns typed commands, queries, subscriptions, dispatch, application cancellation/errors and dependency composition. Workspace, Pi and SSH expose focused Effect services/layers with injected dependencies and keep their own validation/resources/domain rules. Each process creates one scoped root runtime and acquires shared dependencies once; feature packages return Effects/scoped streams. React receives a browser-safe client; UI, keyboard, native and transport entry points use the same handlers. Keep buffers/rendering/pure editor calculations ordinary TypeScript. Standalone editor and chat compositions install only their own capabilities. Pi Durable owns execution, transcripts and tasks. Use resource-appropriate concurrency so long work cannot block unrelated commands or Stop; keep the center small without another scheduler, event store or global command queue.

Test nontrivial behavior through public interfaces, including loss/conflict/uncertainty, disposal and exact local/remote identities. Distinguish source checks, controlled integration, packaged execution and real/manual checks. Preserve dirty work, trust-boundary validation, required notices and observable errors. No legacy-state import or deletion, real-provider quota without explicit authorization, unspecified SSH host, host-key bypass, deployment or GitHub PR merges.

Keep PRs focused on module boundaries and include related fixes in their owning module. Link PRs with T3 when available.
