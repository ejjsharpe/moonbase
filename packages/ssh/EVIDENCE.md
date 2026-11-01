# SSH evidence

Task 06 starts at exact `09b21f2ee8556c54ef4f8238f0be2ee88fd990c3`, `chore/connection-contract` / PR #8. Dependencies are #1 → #2 → #5 → #6 → #8. The checked host-health/connection contracts are used unchanged; neither the workspace/editor implementation nor sibling #7/Pi code is imported. The existing `feat/workspace-module` checkpoint `38c6c551ff0ab1108077275d223a32967f32b9f6` remains intact on its published branch. Work occurs in the same Moonbase-bound isolated worktree on actual Git branch `feat/ssh-transport`.

Scope: `packages/ssh/**` only. `SshLive` supplies the shared service, and every tested public action uses `makeConnectionClient` or the privileged shared service lookup. Production code returns scoped Effects/streams and never creates a root runtime. The example is a separate executable composition root. The manifest adds only `@moonbase/application: workspace:*` and existing `effect: 4.1.0`, with `.` exporting `./src/index.ts`. Local workspace links were prepared with `bun install --no-save`, preserving the root lockfile; coordinator registration/frozen-install qualification is pending.

Environment: macOS arm64, Node 26.13.0, Bun 1.4.4, pinned TypeScript 7.0.2 / Effect 4.1.0, installed OpenSSH_10.2p1 / LibreSSL 3.3.6. A local `ssh -G` syntax test reads no user SSH configuration (`-F /dev/null`) and makes no network connection. It verifies foreground/no-control-socket options and the explicit loopback forward. This is not an SSH handshake.

Commands:

```sh
bun run --cwd packages/ssh typecheck
bun run --cwd packages/ssh lint
bun run --cwd packages/ssh build
bun run --cwd packages/ssh test
bun run --cwd packages/application test
bun run check:foundation
git diff --check
```

**24 SSH tests passed, zero failures/skips; 29 application tests passed**, plus package typecheck/lint/build diagnostics, foundation40-hash/browser-boundary checks and diff checks. The installed SSH syntax assertion was corrected to the actual `-G` representation (`ControlPath=none` is omitted, loopback addresses are bracketed). No production behavior was changed to accommodate the assertion.

A separate focused test ran the actual `examples/connect.ts` composition-root process against the controlled host, verified public-only output and cleanup, and rejected malformed private JSON without echoing its contents. An esbuild Node bundle/import-graph check succeeded with 253 inputs and zero editor/workspace/Pi/React/Electron implementation imports (462,668 output bytes, held in memory only; not a packaged application).

The controlled suite uses actual temporary executable paths containing spaces, real child processes/TCP forwards/Node HTTP, and nonce/HMAC replies from the shared host helper:

- Initial status and privileged endpoint lookup spawn nothing. Two public clients share one generation: one preflight and one actual forwarding child. Config/endpoint projection drops private extras; output mutation cannot change the private authority. The application key is absent from argv, public snapshot/error objects, inherited subprocess environment and observed health request bytes; only nonce-bound proofs travel.
- Forwarded health rejects wrong key, host, store and version. A stalled response and a child that never opens its port are bounded and cleaned up. A live TCP listener/unsigned data is not promoted to an authenticated host. Every observed application request is `/v1/health`; there is no Send/Stop/resend implementation.
- Status remains usable during slow startup. Coalesced Connect calls spawn no duplicate forward. Cancellation/disconnect/root disposal during startup settle waiting calls and close children. A new connection receives a new ID; a stale disconnect never closes it. Observer unsubscribe leaves connectivity intact. Actual child exit changes status and invalidates the privileged endpoint; reconnect does not invoke a job or replay input.
- Real fixture `EADDRINUSE` rejects a port collision, retaining no child/port; a later explicit new attempt succeeds. Spawn failure, SSH host-key/authentication diagnostics and configuration-output overflow surface static typed errors without raw stderr. Extra forward rules, disabled host-key checking, clear-forward policy and device tunnels reject before forwarding; invalid renderer/config inputs cannot select an arbitrary destination or credential.
- A SIGTERM-ignoring child is forcibly reaped without closing another root runtime's child. A throwing-proxy process release remains observable without leaking the synthetic key; restored process access lets root cleanup finish. Observer resource limits, immediate unsubscribe and concurrent root disposal are covered. Cleanup assertions check every recorded PID is gone and every forwarded local port can be rebound; fixture HTTP hosts are independently owned and closed separately.

Process mechanics preserve operator-managed configuration/agent/key/host-key policy while forbidding unmanaged multiplex ownership and unsafe forwards. Private stdout is byte-bounded, diagnostics are character-bounded, watch queues coalesce and resource releases use the shared normalization convention. Port selection and OpenSSH binding are separate operations; hostile local races/live health relaying are not ruled out. Health is read-only and does not authenticate future stateful chat requests.

UNRUN: real OpenSSH client/server handshake, known-host accept/reject/rotation, ProxyJump/agent interactions against a real target, remote Pi/provider execution/persistence, packaged Electron/renderer privilege isolation, signing, manual/native/product acceptance, machine crash/power loss and actual remote network partition behavior. No explicit real test host was supplied. No user host scan, sshd/Remote Login provisioning, credential request/exposure, provider quota, deployment or remote state/job mutation occurred. Independent review and HUMAN ACCEPTANCE remain pending.
