import { spawn, type ChildProcess } from 'node:child_process';
import { ApplicationError } from '@moonbase/application/client';

const unavailable = (message: string) => new ApplicationError({code: 'Unavailable', message});
export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; spawnFailed: boolean };
/** Own only this child, drain bounded private diagnostics, never return raw SSH output as an error. */
export class SshProcess {
  readonly child: ChildProcess;
  readonly closed: Promise<ProcessExit>;
  output = '';
  stderr = '';
  overflow = false;
  private outputBytes = 0;
  exited: ProcessExit | undefined;
  private stopping: Promise<void> | undefined;
  constructor(executable: string, args: string[], token: string, captureOutput: boolean) {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[1].includes(token)));
    this.child = spawn(executable, args, {shell: false, stdio: ['ignore', 'pipe', 'pipe'], env});
    this.closed = new Promise(resolve => {
      let spawnFailed = false;
      const failed = () => { spawnFailed = true; };
      const stdout = (chunk: Buffer) => {
        if (!captureOutput) return;
        this.outputBytes += chunk.byteLength;
        if (this.outputBytes > 64 * 1024) { this.overflow = true; this.child.kill('SIGTERM'); }
        else this.output += chunk.toString('utf8');
      };
      const stderr = (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8192); };
      this.child.on('error', failed); this.child.stdout!.on('data', stdout); this.child.stderr!.on('data', stderr);
      this.child.once('close', (code, signal) => {
        this.exited = {code, signal, spawnFailed};
        this.child.off('error', failed); this.child.stdout!.off('data', stdout); this.child.stderr!.off('data', stderr);
        resolve(this.exited);
      });
    });
  }
  failure(): ApplicationError {
    if (this.exited?.spawnFailed) return unavailable('Could not start system SSH. Verify the configured executable and its permissions.');
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed/i.test(this.stderr)) return unavailable('SSH host key verification failed. Have the operator verify the known host key before retrying.');
    if (/address already in use|cannot listen to port|could not request local forwarding/i.test(this.stderr)) return unavailable('SSH could not bind its local forward. Another listener may have claimed the port; retry with a new connection.');
    if (/permission denied|authentication failed/i.test(this.stderr)) return new ApplicationError({code: 'Unauthorized', message: 'SSH authentication failed. Verify the configured SSH alias, agent and key access.'});
    if (this.overflow) return unavailable('SSH configuration output exceeded its bound. Use a focused connection profile.');
    return unavailable('SSH exited. Check the configured alias, network, host key policy and independently running chat host.');
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.exited) return;
      const wait = async (milliseconds: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([this.closed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
        finally { clearTimeout(timer); }
      };
      this.child.kill('SIGTERM');
      if (!await wait(500)) { this.child.kill('SIGKILL'); if (!await wait(2000)) throw unavailable('Owned SSH child did not terminate. Connection teardown remains incomplete.'); }
    })().catch(() => { this.stopping = undefined; throw unavailable('Owned SSH child teardown failed. Retry release after resolving the process access failure.'); });
    return this.stopping;
  }
}
