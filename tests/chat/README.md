# Chat integration

Exercises public application clients with the real Pi HTTP server/SQLite store and a controlled TCP forwarding child. One client root composes `RemoteChatLive` with `SshLive`; a separate Node process owns the Pi host runtime. The clients share one connection service.

From the repository root with Node 26.13.0 and pinned dependencies:

```sh
bun run test:chat-integration
```

The suite covers explicit connection and authenticated identity, Create/Send/Stop reply loss, immutable retry/receipt resolution, restart without resend, stale-generation Disconnect, responsive status during held replies and resource cleanup. Temporary stores, counted faux providers and synthetic SSH configuration avoid real provider/host access.

`host.mjs`, `tool-host.mjs`, wrappers and `forward.mjs` are test fixtures, not product transports. The tool host also supplies controlled streamed output to headless chat and desktop tests. Fault injection drops or holds actual production HTTP replies after dispatch.

This is controlled cross-process transport evidence. It does not qualify real SSH authentication/agents/proxies, provider access, packaged/native UI, shipped host notices, physical durability or human acceptance.

Transcript integration additionally covers both read operations, exact identity echoes, wrong conversation/actor/store, lost and tampered response bytes, held replies, cancellation, reconnect generations and independent Stop/unrelated conversations. Forwarding fault controls apply to named operations; existing Send-loss fixtures retain their original default.

`stream-host.mjs` publishes controlled thinking/text revisions, then holds completion. Public watch/SDK read counters prove zero recurring capable-host `getChat`, reuse of unchanged history/status, no A refresh from B, exact Stop independence and listener release. `tool-host.mjs` separately proves tool progress while execution is held. These are controlled process/forwarding checks, not real SSH/provider or packaged UI evidence.
