# Chat integration

Runs public application clients against the real daemon in host mode, in temporary data on Bun, reached through a controlled TCP forwarder in place of SSH. Covers connection and authentication, reply loss and retry for Create/Send/Stop, restart without resend, streaming, transcript reads, approved roots and `@` search, provider setup and model choice, and cleanup. Providers are counted fakes; no real provider or SSH host is used.

```sh
bun run test:chat-integration
```

`daemon-host.ts` is the host's test entry: `runDaemon` with the faux providers and tools of a behaviour module (`faux-reply.mjs`, `faux-stream.mjs`, `faux-tool.mjs`, or the desktop's `faux-stored-image.mjs`), and `host-control.ts` counting and holding requests over IPC. These and `forward.mjs` are test fixtures, not product code. Run this suite serially with other resource-heavy suites.
