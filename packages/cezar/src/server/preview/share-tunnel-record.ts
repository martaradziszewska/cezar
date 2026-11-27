import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { atomicWriteJsonSync } from '../../workspace/config.ts';

/**
 * Which `cloudflared` children are running, on disk, so a cezar that was killed hard does not leave
 * a public address pointing at a port anyone may bind next (spec 2026-11-26-preview-share-link
 * § Exposure, "A stray child"). Every failure is swallowed: no record is today's behaviour.
 */

const recordSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  startedAt: z.string(),
  /** The cezar that spawned it. While that is still its parent, the tunnel is live, not stale. */
  owner: z.number().int().positive().optional(),
});
export type TunnelRecord = z.infer<typeof recordSchema>;

const RECORDS_MAX = 64;
const KILL_GRACE_MS = 2_000;
const PS_TIMEOUT_MS = 5_000;

type Signal = 'SIGTERM' | 'SIGKILL' | 0;

export interface ReapDeps {
  path?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The pid's parent and command line, or `null` when it cannot be told. */
  inspect?(pid: number): Promise<{ ppid: number; command: string } | null>;
  /** `false` when the pid is gone or not ours to signal. Signal `0` only asks. */
  kill?(pid: number, signal: Signal): boolean;
  graceMs?: number;
}

/** Beside the star count and the skills cache; there is no env override, so tests pass a path. */
export function tunnelRecordPath(home: string = homedir()): string {
  return join(home, '.cache', 'cez', 'share-tunnels.json');
}

/** `null` under vitest without a path: a test never reads or writes the real cache. */
function resolvePath(path: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (path !== undefined) return path;
  return env.VITEST ? null : tunnelRecordPath();
}

function read(path: string): TunnelRecord[] {
  try {
    const parsed = z.array(recordSchema).max(RECORDS_MAX).safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function write(path: string, records: readonly TunnelRecord[]): boolean {
  try {
    // No file once empty: boot looks at nothing and spawns nothing.
    if (records.length === 0) rmSync(path, { force: true });
    else atomicWriteJsonSync(path, records);
    return true;
  } catch {
    return false;
  }
}

export function hasTunnelRecords(path?: string): boolean {
  const file = resolvePath(path);
  return file !== null && read(file).length > 0;
}

export function recordTunnel(record: TunnelRecord, path?: string): boolean {
  const file = resolvePath(path);
  if (file === null) return false;
  return write(file, [...read(file).filter((known) => known.pid !== record.pid), record].slice(-RECORDS_MAX));
}

export function forgetTunnel(pid: number, path?: string): boolean {
  const file = resolvePath(path);
  if (file === null) return false;
  const records = read(file);
  const kept = records.filter((known) => known.pid !== pid);
  return kept.length === records.length ? true : write(file, kept);
}

/** POSIX `ps`: the parent pid and the whole command line of one pid. */
export function inspectWithPs(pid: number): Promise<{ ppid: number; command: string } | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'command='], { timeout: PS_TIMEOUT_MS }, (error, stdout) => {
      const found = error ? null : /^\s*(\d+)\s+(.+)$/.exec(String(stdout).trim());
      resolve(found ? { ppid: Number(found[1]), command: found[2]! } : null);
    });
  });
}

function signalProcess(pid: number, signal: Signal): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Ours only when the command is the one cezar spawns, for the port it was recorded with. */
function isOurTunnel(command: string, port: number): boolean {
  return command.includes('cloudflared') && new RegExp(`--url http://127\\.0\\.0\\.1:${port}(?!\\d)`).test(command);
}

/**
 * Ends recorded tunnels whose cezar is gone, then drops their entries. A pid is signalled only
 * after `ps` shows cezar's own command line on it; one still parented by the cezar that recorded it
 * is a live share and is left alone. Never throws.
 */
export async function reapStaleTunnels(deps: ReapDeps = {}): Promise<void> {
  try {
    const env = deps.env ?? process.env;
    if (env.CEZ_DRY_RUN === '1') return;
    // Under test only fakes may be asked about, or signal, a pid.
    if (env.VITEST && (deps.path === undefined || deps.inspect === undefined || deps.kill === undefined)) return;
    const file = resolvePath(deps.path, env);
    if (file === null) return;
    const records = read(file);
    if (records.length === 0) return;
    const inspect = deps.inspect ?? inspectWithPs;
    const kill = deps.kill ?? signalProcess;
    const platform = deps.platform ?? process.platform;
    const kept: TunnelRecord[] = [];
    for (const record of records) {
      try {
        if (!kill(record.pid, 0)) continue;
        // win32 has no `ps` to confirm what a pid runs, so nothing is killed there: entries only go.
        if (platform === 'win32') continue;
        const seen = await inspect(record.pid);
        if (seen === null || !isOurTunnel(seen.command, record.port)) continue;
        if (record.owner !== undefined && seen.ppid === record.owner) {
          kept.push(record);
          continue;
        }
        kill(record.pid, 'SIGTERM');
        const escalate = setTimeout(() => {
          void inspect(record.pid)
            .then((still) => {
              if (still !== null && isOurTunnel(still.command, record.port)) kill(record.pid, 'SIGKILL');
            })
            .catch(() => {});
        }, deps.graceMs ?? KILL_GRACE_MS);
        escalate.unref();
      } catch {
        // Unjudged: neither killed nor kept.
      }
    }
    // Entries another cezar added while `ps` ran stay.
    const added = read(file).filter((now) => !records.some((before) => before.pid === now.pid));
    write(file, [...kept, ...added]);
  } catch {
    // A read-only or missing cache is no record at all.
  }
}
