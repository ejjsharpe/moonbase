# Process group

`@moonbase/process-group` starts a child process in its own process group and stops the whole group. The file host's helper, the chat file listing and OpenSSH run through it.

| Export | What it gives |
| --- | --- |
| `ProcessGroups` | The service. `spawn(executable, args, { stdio, stopOnClose, env?, cwd?, stopTiming })` gives a scoped `ProcessGroup`: the child for its pipes, its `exit`, `closed` (every pipe closed), `signal` and `stop`; it fails with `ProcessGroupError` (`start`). `ProcessGroups.layer` signals real groups; `ProcessGroups.layerWith(signalGroup)` takes the group signal, so tests can inject its outcomes |
| `outputDrain` | How long output written before the leader exited has to arrive while another process holds a pipe (100 ms) |
| `onSystemClock` | Runs an effect on the system clock, for waits on real processes |

## Rules worth knowing

- **Stopping** sends SIGTERM to the group, then SIGKILL after `termGrace`, and waits until no member is left and its pipes are closed, all within `deadline`. Pipes another process still holds once the group is gone are ended here.
- **Only ESRCH confirms the group is gone.** Darwin can report EPERM for an exiting group, so EPERM is signalled again: SIGTERM until `termGrace` ends, then SIGKILL until the deadline, so SIGKILL is always tried. A stop that fails is a `ProcessGroupError` (`teardown`) and is tried again by the next call.
- **ESRCH is final.** The step that sees it records it, and no stop or signal reaches that group ID again, even after an interrupted stop.
- **Closing the Scope** stops the group as its owner's `stopOnClose` says, even when the Scope was already closed, then ends the pipes: `always` (OpenSSH, whose exited leader can leave a proxy behind), `while-open`, while a pipe is open or the leader is unreaped (the chat file listing, so a member still holding its output is stopped), or `never`, when the owner stops it from its own finalizer (the file host's helper, while its run is unsettled, waiting for the helper's exit when the stop fails so the checkout's lease and journal stay held).
- **The close stays bounded.** A stop that fails while closing is not retried or waited out and adds no defect, so a caller's typed failure, such as an explicit `stop`'s `teardown`, is what its Scope ends with.
- **The stop runs on the system clock**, since it waits on real processes, even when the caller's clock is a TestClock.
- **It wraps `node:child_process` once** rather than using `effect/process`, because the stop must signal the whole group, keep signalling through EPERM and fail when the group's absence stays unconfirmed, and `effect/process`'s release would signal the group again after it was confirmed gone.

## Known limit

A group ID is free for reuse once the leader has been reaped and its last member has exited. A check or signal sent in that window, between the last exit and the ESRCH that records it, can reach a new group with the same ID. Each owner signals on close under the same condition it did before this package, which keeps the window as narrow as it was. Closing it would take a native supervisor that holds the group.

## Checks

```sh
bun run --cwd packages/process-group typecheck
bun run --cwd packages/process-group lint
bun run --cwd packages/process-group test
```

Its tests inject the group signal to cover ESRCH, EPERM and the Scope's close. The consumers' suites cover real groups: the workspace native race and ownership tests, the chat file listing tests and the SSH tests.
