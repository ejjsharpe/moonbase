# Reviewed Pi and SSH integration

Working branch `chore/chat-integration` combines Pi `235eb27a448635a995bb65e67147e99119830b92` (PR #12, disconnect repair awaiting fresh review) and SSH `1aec1a438ba0d5592b0e6c3f0e1be835cf3c034b` (PR #9, Astra R3 controlled-transport clear). Original merge `66da1b8` preserves both ancestries; the normal follow-up merge retains the Pi generation repair. Astra R2 clearance applies only to the earlier Pi `cbe9478` checkpoint. Only the original coordinator lockfile conflict was regenerated; the follow-up carries the focused Pi remote fix. Shared application and SSH source are unchanged.

The client composition uses the public services and the existing root-bound handlers:

```ts
const runtime = ManagedRuntime.make(
  RemoteChatLive.pipe(Layer.provideMerge(SshLive(configuration))),
);
const chat = makeChatClient(runtime);
const connection = makeConnectionClient(runtime);
```

One client runtime acquires the shared connection once. A **separate Node process** hosts `PiRuntimeLive` and `serveChat` through one host runtime. Its official public faux provider makes no provider-network calls and receives only platform environment variables. Credentials and database remain with that controlled host; public connection snapshots expose neither key nor forwarded origin. The fixture uses temporary stores and canonical host cwd, never editor source/authority or legacy data.

## Observable checks

Run `bun run test:chat-integration` under the qualified Node 26.13 baseline. The consumer typecheck uses ES2024 libs for the already-qualified SDK/remote source APIs.

1. No implicit Connect; disconnected chat queries fail. Explicit Connect verifies real production HMAC health through the controlled forward. Create/matching retry/list/get/watch use actual HTTP, shared handlers and Pi SQLite. Fixed cwd/model come from the host. Both public clients use one forwarding child.
2. The controlled TCP child drops the **actual HTTP Send response** after the production server dispatches. The client reports `Uncertain`; the captured input ID is retained. Client runtime disposal does not Stop the held host work. A new root reconnects and resolves the original receipt through read-only lookup. Completing work and reopening the host's real SQLite preserves that receipt and one user input; no new Send/model execution occurs. One drop and one Send dispatch are counted.
3. Disconnect denies chat commands without reconnecting implicitly. A stale Disconnect returns `Conflict` while the current generation remains connected. Captured exact-task Stop is cooperative; releasing the controlled provider settles it. No new input or successor is adopted.
4. A valid signed health identity from another host cannot connect or provide a chat endpoint. Only normal health metadata reads occur; no stateful command/model call is admitted.

5. For each of Create, Send and Stop, the separate host holds its reply **after the public command committed**. Explicit Disconnect tears down the actual controlled forwarding process. The call must retain `Uncertain`, then explicit reconnect resolves the original request/conversation/task without a new Send or provider call. The three new assertions fail with `Unavailable` against integration `478ab94` and pass with Pi `235eb27`. Unrelated connection queries stay responsive while replies are held.

Every test disposes all client roots and the separate host, checks recorded forwarding PIDs are absent and ports can rebind, and restores fixture environment variables. The controlled forward uses real TCP/children but supplies synthetic SSH configuration: this is **controlled transport**, not a real SSH handshake/host-key/agent/ProxyJump qualification. Those independent source cases live in PR #9; no real remote test host was supplied.

`host.mjs`, `tool-host.mjs`, the fixture wrappers and `forward.mjs` are test-only first-party fixtures, not product transports or runtime assets. The response-drop parser is bounded and only arms an explicit fixture fault. No feature test helper/private implementation is imported, no transcript store or scheduler is added, and no fixture key appears in argv/logs/public output.

## Validation at this integration

- **7/7** real cross-process HTTP/SQLite/forwarding checks pass with strict consumer TypeScript checking. Exact commands/logs: `/tmp/moonbase-chat-generation-green.log`.
- Nine uncached Nx typecheck/lint/test tasks pass: application **33**, Pi **53**, SSH **43** = **129** module/shared tests. Combined with the seven boundary tests: **136**. Lint remains TypeScript diagnostics. Log: `/tmp/moonbase-chat-generation-nx.log`.
- Frozen install, browser contract checks, authored diff checks pass. Effect stays **4.1.0**, all three Pi dependencies **1.4.0** and SSH uses the preserved platform executable policy.
- A static esbuild audit of the public client-exports entry records **260 inputs / 535,926 bytes**, including application runtime client, RemoteChatLive and SshLive. It excludes editor/workspace, Pi engine/server/CLI, Pi/Chord/provider SDK implementations, React/Electron and reference source. The host is a separate executable fixture, not part of that client graph. This is no claim about the future chat renderer or packaged application. This re-export entry differs from the original composition audit (260 inputs / 552,475 bytes), so emitted byte counts are not a size-regression comparison. Full input list: `/tmp/moonbase-chat-generation-client-graph.json`.
- Initial harness checks were corrected before final qualification: ES2024 source-consumer typing, canonical temporary cwd, documented stale-generation Conflict, and normal startup/health `getChatHost` reads. No module guarantee or implementation was weakened to match the fixture.

The shared [headless chat controller](../../packages/chat/README.md) uses `tool-fixture.ts` and `tool-host.mjs` for protocol checks and desktop composition tests. The tool host adds controlled streamed output; `host.mjs` remains the separate backend integration host. This integration has no UI and establishes no real provider/SSH, packaged/native, optional-engine, physical-durability or human acceptance. Pi host distribution notices remain a separate gate; the coordinator's pinned upstream notice/source-correspondence research does not qualify a shipped transitive graph.

## Independent review checkpoints

PR #15 Astra R1 found that final generation validation replaced a committed mutation’s unknown outcome with `Unavailable`. Its three independent Create/Send/Stop reproductions are retained in the review report. The new tests reproduce the same defect before the fix (4 prior controls pass / 3 new cases fail), and pass after the normal Pi repair merge. The module adds eight focused HTTP/generation/release controls, retains cancellation and pre-dispatch/read semantics, and passed 53 Pi +33 shared tests. Fresh paired module/integration review and new-head hosted CI remain pending; no earlier approval is extended automatically.
