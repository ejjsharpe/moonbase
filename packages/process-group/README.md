# Process group

`@moonbase/process-group` starts a child process in its own process group and stops the whole group. The file host's helper, the chat file listing and OpenSSH run through it.

| Export | What it gives |
| --- | --- |
| `spawnProcessGroup(executable, args, { stdio, env?, cwd?, stopTiming })` | A scoped `ProcessGroup`: the child for its pipes, its `exit`, `closed` (every pipe closed), `signal` and `stop`; it fails with `ProcessGroupError` (`start`) |
| `outputDrain` | How long output written before the leader exited has to arrive while another process holds a pipe (100 ms) |
| `onSystemClock` | Runs an effect on the system clock, for waits on real processes |

## Rules worth knowing

- **Stopping** sends SIGTERM to the group, then SIGKILL after `termGrace`, and waits until no member is left and its pipes are closed, all within `deadline`. Pipes another process still holds once the group is gone are ended here. Closing the Scope stops the group.
- **Only ESRCH confirms the group is gone.** Darwin can report EPERM for an exiting group, so EPERM is signalled again until the deadline. A stop that fails is a `ProcessGroupError` (`teardown`) and is tried again by the next call; one that succeeded is final, so a reused group ID is never signalled.
- **The stop runs on the system clock**, since it waits on real processes, even when the caller's clock is a TestClock.
- **It wraps `node:child_process` once** rather than using `effect/process`, because the stop must signal the whole group, keep signalling through EPERM until its deadline and fail when the group's absence stays unconfirmed, and `effect/process`'s release would signal the group again after it was confirmed gone.

## Checks

```sh
bun run --cwd packages/process-group typecheck
bun run --cwd packages/process-group lint
```

Its behaviour is tested through its consumers: the workspace native race and ownership tests, the chat file listing tests and the SSH tests.
