# Chat integration

Runs public application clients against a real Pi host process with a temporary SQLite store, reached through a controlled TCP forwarder in place of SSH. Covers connection and authentication, reply loss and retry for Create/Send/Stop, restart without resend, streaming, transcript reads and cleanup. Providers are counted fakes; no real provider or SSH host is used.

```sh
bun run test:chat-integration
```

`host.mjs`, `stream-host.mjs`, `tool-host.mjs` and `forward.mjs` are test fixtures, not product code. Run this suite serially with other resource-heavy suites.
