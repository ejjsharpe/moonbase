# SSH connection capability

`@moonbase/ssh` exports `SshLive(config)`, a scoped layer providing the shared `ConnectionService`. It has no editor, React, Electron, Pi, workspace database or provider dependency and creates no runtime. Compose it once in the application's privileged process root and use the shared `makeConnectionClient`/handlers for status, Connect and exact-generation Disconnect.

```ts
import { ManagedRuntime } from 'effect';
import { makeConnectionClient } from '@moonbase/application/runtime-client';
import { SshLive } from '@moonbase/ssh';

// Consumer process composition root; load this private configuration outside the renderer.
const runtime = ManagedRuntime.make(SshLive(privateConfiguration));
const client = makeConnectionClient(runtime);
const initial = await client.command('getConnection', {}); // No SSH admission.
const connected = await client.command('connect', {profileId: initial.profile.id});
if (connected.state === 'connected') {
  await client.command('disconnect', {connectionId: connected.connectionId});
}
await runtime.dispose();
```

Configuration has exactly one public profile `{id,label,destination,remotePort,expected:{hostId,storeId}}`, plus the private application `token` and optional absolute `sshExecutable` (default `/usr/bin/ssh`). The destination accepts a simple SSH alias, host, bracketed IPv6 address or `user@host`; SSH ports, proxy settings, agent/key selection and known-host policy belong in operator-managed SSH configuration. Browser commands cannot supply destinations, ports, keys or forwarded origins. Public profile/health objects are projected explicitly, copied on output, and omit unknown/private extra properties. The reusable key must be separate from public fields.

Each generation owns a read-only `ssh -G` configuration preflight and one foreground nonmultiplexed `ssh -N -T -n` child. Arguments use `spawn` without a shell. `ControlMaster=no`, `ControlPath=none`, `ControlPersist=no` and `ForkAfterAuthentication=no` prevent reuse of an unmanaged master or background ownership escape. `BatchMode=yes` requires existing noninteractive agent/key access. No SSH key/known-host file is edited by this package. It never passes a host-key bypass, remote command, install command or service/job control. Existing trusted SSH policy, including ProxyJump/ProxyCommand and Match hooks, remains OpenSSH's responsibility; those operator-authored hooks are not a renderer input.

A dedicated profile must have no additional local/remote/dynamic forwards or device tunnel, must not clear the required forward, and must retain host-key checking. Enabled `NoHostAuthenticationForLocalhost` or macOS `NoHostAuthenticationForProxyCommand` bypasses also reject, even with `StrictHostKeyChecking=yes`; ordinary disabled-bypass policy is retained. The preflight rejects incompatible policy with an actionable error; it does not rewrite user SSH configuration. The sole requested forward is `127.0.0.1:ephemeral → remote 127.0.0.1:remotePort`, with explicit `GatewayPorts=no` and `ExitOnForwardFailure=yes`. Local-command, agent and X11 forwarding are disabled for this tunnel; SSH still uses the existing authentication agent. The temporary port reservation is released before OpenSSH binds it. Another process can claim that gap; SSH must fail its forward rather than silently selecting another endpoint. This is not an atomic port handoff or a claim about hostile local processes.

Concurrent Connect calls share the active attempt/connected generation, with a fresh ID after teardown. The owning release path settles every admitted waiter even when a first connecting observation triggers Disconnect/root disposal before the attempt starts; a released generation cannot later spawn. Admitted teardown finishes despite caller cancellation. Status remains available during startup. Cancellation of any waiter while the shared attempt is still connecting cancels that generation for all waiters; cancelling an already returned connection or ending an observation does not disconnect. Disconnect names the captured generation; a stale ID cannot close a newer child. A repeated release when no child remains is harmless. Reconnect verifies health only and never sends chat input or stops the independent remote host/jobs.

Authenticated health is required before connected status or privileged endpoint access. The module calls the shared nonce/HMAC `checkHostHealth` against its private forward, requiring the configured host/store and exact protocol/application versions. The startup deadline is 20 seconds; individual health request/body bounds are five seconds/8 KiB, with short retries only for network unavailability while the child lives. Wrong authentication/identity/version fails visibly. Health proves a point-in-time application identity; it does not guarantee later network liveness, authorize Send/Stop, prevent live relaying, or replace SSH machine authentication. No bearer fallback is used.

Privileged consumers may query `ConnectionService.endpoint({host})` inside the same process graph. It returns the exact current verified `{origin,token,expected,connectionId,health}` or fails, without connecting or rebinding. Never bridge that result to the renderer, print it, or treat the health proof as future chat RPC authorization. Public snapshots, status/errors and child arguments contain no private origin/key. SSH subprocesses do not inherit environment values containing the configured application key. Private SSH configuration output is capped at 64 KiB and stderr at 8,192 characters; only static diagnostic categories reach callers, never raw output.

Each observer owns a sliding one-status queue, acquired/finalized outside `Stream.callback`; at most 64 are active. Unsubscribe removes only that queue. On POSIX systems, each SSH process is a referenced leader of a new owned session/process group; it is never unref'd. Root disposal closes all scoped fibers and owned groups, including their ProxyCommand/helpers. Actual `exit` invalidates status/endpoint immediately; inherited-pipe `close` only records bounded drainage. Release still checks/signals the captured group after the main PID exits or its pipes close, tries SIGTERM then SIGKILL after 500 ms within a 2.5-second stop budget, and drains/closes owned pipe readers separately. An exiting macOS group may briefly return `EPERM`; release retries that unresolved observation/signalling within the same budget and requires confirmed group absence. Persistent ambiguity fails visibly and retains the generation for a later explicit release; an interrupted attempt does not immediately spend another cleanup budget. It never targets the app, an existing agent/master or another runtime's group. See [Node's event and process-group semantics](https://nodejs.org/api/child_process.html#event-close). Windows is rejected because this capability requires POSIX group ownership. Unknown release failures are normalized by the shared `releaseResource`, remain visible and block a new generation until release succeeds. There is no global command queue or feature-owned root runtime.

The runnable consumer is `examples/connect.ts`:

```sh
node --experimental-strip-types packages/ssh/examples/connect.ts /absolute/private-connection.json
```

It reads one operator-provided private JSON configuration and prints only public status. Keep that file outside source control with private permissions. Use an already authorized SSH alias and verified known-host policy. Separately start the approved chat host on the remote machine, bound to `127.0.0.1` at the configured port, with the same privately provisioned application key and exact host/store identities. The Pi host CLI is not implemented by this module; no invented host-start command, remote provisioning or automatic service startup is supplied. Missing host/key setup is an operator prerequisite for a real connection, not something this package creates or scans.