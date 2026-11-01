import { spawn, type ChildProcess } from 'node:child_process';
import { ApplicationError } from '@moonbase/application/client';

const unavailable = (message: string) => new ApplicationError({ code: 'Unavailable', message });
export type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnFailed: boolean;
};
/** Own one POSIX process group; process exit and inherited-pipe drainage are separate facts. */
export class SshProcess {
  readonly child: ChildProcess;
  readonly terminal: Promise<ProcessExit>;
  readonly closed: Promise<ProcessExit>;
  output = '';
  stderr = '';
  overflow = false;
  private outputBytes = 0;
  exited: ProcessExit | undefined;
  private stopping: Promise<void> | undefined;
  constructor(executable: string, args: string[], token: string, captureOutput: boolean) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !entry[1].includes(token),
      ),
    );
    // A new process group is still referenced/scoped; it is never unref'd or shared with user processes.
    this.child = spawn(executable, args, {
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let terminal!: (exit: ProcessExit) => void;
    this.terminal = new Promise((resolve) => {
      terminal = resolve;
    });
    const exited = (code: number | null, signal: NodeJS.Signals | null, spawnFailed = false) => {
      if (this.exited) return;
      this.exited = { code, signal, spawnFailed };
      terminal(this.exited);
    };
    this.closed = new Promise((resolve) => {
      let spawned = false;
      const started = () => {
        spawned = true;
      };
      const failed = () => {
        if (!spawned) exited(null, null, true);
      };
      const ended = (code: number | null, signal: NodeJS.Signals | null) => exited(code, signal);
      const stdout = (chunk: Buffer) => {
        if (!captureOutput) return;
        this.outputBytes += chunk.byteLength;
        if (this.outputBytes > 64 * 1024) {
          this.overflow = true;
          try {
            this.signal('SIGTERM');
          } catch {
            /* Owning release reports a process-control failure. */
          }
        } else this.output += chunk.toString('utf8');
      };
      const stderr = (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8192);
      };
      const pipeError = () => {}; // Raw pipe errors are private; exit/deadline and release remain observable.
      this.child.once('spawn', started);
      this.child.once('exit', ended);
      this.child.on('error', failed);
      this.child.stdout!.on('data', stdout);
      this.child.stderr!.on('data', stderr);
      this.child.stdout!.on('error', pipeError);
      this.child.stderr!.on('error', pipeError);
      this.child.once('close', (code, signal) => {
        exited(code, signal, !spawned);
        this.child.off('spawn', started);
        this.child.off('exit', ended);
        this.child.off('error', failed);
        this.child.stdout!.off('data', stdout);
        this.child.stderr!.off('data', stderr);
        this.child.stdout!.off('error', pipeError);
        this.child.stderr!.off('error', pipeError);
        resolve(this.exited!);
      });
    });
  }
  failure(): ApplicationError {
    if (this.exited?.spawnFailed)
      return unavailable(
        'Could not start system SSH. Verify the configured executable and its permissions.',
      );
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed/i.test(this.stderr))
      return unavailable(
        'SSH host key verification failed. Have the operator verify the known host key before retrying.',
      );
    if (
      /address already in use|cannot listen to port|could not request local forwarding/i.test(
        this.stderr,
      )
    )
      return unavailable(
        'SSH could not bind its local forward. Another listener may have claimed the port; retry with a new connection.',
      );
    if (/permission denied|authentication failed/i.test(this.stderr))
      return new ApplicationError({
        code: 'Unauthorized',
        message:
          'SSH authentication failed. Verify the configured SSH alias, agent and key access.',
      });
    if (this.overflow)
      return unavailable(
        'SSH configuration output exceeded its bound. Use a focused connection profile.',
      );
    return unavailable(
      'SSH exited. Check the configured alias, network, host key policy and independently running chat host.',
    );
  }
  private signal(signal: NodeJS.Signals | 0) {
    const pid = this.child.pid;
    if (!pid) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw e;
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const deadline = Date.now() + 2500;
      const attempt = (signal: NodeJS.Signals | 0) => {
        try {
          return this.signal(signal);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EPERM') return undefined;
          throw e;
        }
      };
      const send = async (signal: NodeJS.Signals) => {
        while (attempt(signal) === undefined) {
          if (Date.now() >= deadline)
            throw unavailable('Owned SSH process group access remained unresolved.');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const gone = async (milliseconds: number) => {
        const until = Date.now() + milliseconds;
        // Darwin can report EPERM for an exiting group; only ESRCH confirms absence.
        while (attempt(0) !== false) {
          if (Date.now() >= until) return false;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return true;
      };
      // An exited main PID does not release its proxy/helper group, including closed-pipe helpers.
      if (attempt(0) !== false) {
        await send('SIGTERM');
        if (!(await gone(Math.min(500, Math.max(0, deadline - Date.now()))))) {
          await send('SIGKILL');
          if (!(await gone(Math.max(0, deadline - Date.now()))))
            throw unavailable('Owned SSH process group did not terminate.');
        }
      }
      const drained = async (milliseconds: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            this.closed.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), milliseconds);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      if (!(await drained(Math.min(100, Math.max(0, deadline - Date.now()))))) {
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
        if (!(await drained(Math.max(0, deadline - Date.now()))))
          throw unavailable('Owned SSH output pipes did not close.');
      }
    })().catch(() => {
      this.stopping = undefined;
      throw unavailable(
        'Owned SSH process group teardown failed. Retry release after resolving the process access failure.',
      );
    });
    return this.stopping;
  }
}
