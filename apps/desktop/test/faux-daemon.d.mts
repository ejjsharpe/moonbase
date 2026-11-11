import type { DaemonCommand } from '../src/main/daemon-command.ts';

/** The faux daemon's `faux.json`, as `apps/daemon/test/faux.ts` reads it. */
export type FauxScript = {
  steps?: (
    | { reply: string; thinking?: string }
    | { tool: string; args: Record<string, unknown> }
    | { hold: true }
  )[];
  idleMs?: number;
  pollMs?: number;
  signInUrl?: string;
};

export function findTestBun(): string;
export function makeFauxDaemonCommand(
  directory: string,
  bun?: string,
  build?: string,
): DaemonCommand;
export function prepareDaemonData(userData: string, script?: FauxScript): Promise<string>;
export function writeFauxScript(directory: string, script: FauxScript): Promise<void>;
export function readDaemonPid(directory: string): Promise<number | undefined>;
export function stopDaemon(directory: string, pid?: number): Promise<void>;
export function readFauxCalls(directory: string): Promise<number>;
export function installFauxDaemon(): void;
export function stopTestDaemons(): Promise<number>;
