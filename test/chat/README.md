# Chat integration

Runs the public application chat services against the real daemon in host mode, on Bun in temporary data, reached through a controlled TCP forwarder in place of SSH. It covers connection and authentication, reply loss and retry for Create/Send/Stop without resending, restart, streaming, transcript reads, approved roots and `@` search, provider setup and cleanup. Providers are counted fakes; no real provider or SSH host is used.

```sh
bun run --cwd test/chat test
```

`daemon-host-process.ts` is the host's test entry: `runDaemon` with the faux providers and tools of a behaviour module (`faux-reply.mjs`, `faux-stream.mjs`, `faux-tool.mjs`, or the desktop's `faux-stored-image.mjs`), with `host-control.ts` counting and holding requests over IPC. These and `forward-process.mjs` are test fixtures, not product code. Files run in up to `MOONBASE_TEST_WORKERS` processes (default 4), each host on a port it picks; run the suite apart from other heavy suites.
