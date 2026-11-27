import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  forgetTunnel,
  hasTunnelRecords,
  inspectWithPs,
  reapStaleTunnels,
  recordTunnel,
  tunnelRecordPath,
  type ReapDeps,
  type TunnelRecord,
} from './share-tunnel-record.ts';

/**
 * A hard-killed cezar leaves `cloudflared` running (spec `.ai/specs/2026-11-26-preview-share-link.md`
 * § Exposure, "A stray child"). Every case works on a temp file with a fake `ps` and `kill`: no
 * test reads `~/.cache` or signals a real process.
 */

const OWNER = 4242;
const tunnel = (pid: number, port: number, owner = OWNER): TunnelRecord => ({ pid, port, startedAt: '2026-11-27T10:00:00.000Z', owner });
const cloudflared = (port: number): string => `/opt/homebrew/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:${port}`;

describe('the tunnel record', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-share-tunnels-'));
    path = join(dir, 'cache', 'cez', 'share-tunnels.json');
  });
  afterEach(() => {
    vi.useRealTimers();
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  const stored = (): unknown => JSON.parse(readFileSync(path, 'utf8'));

  /** Fakes for `ps` and `kill`; `processes` is what is running. */
  function world(processes: Record<number, { ppid: number; command: string }>) {
    const signals: Array<[number, string]> = [];
    const inspected: number[] = [];
    const deps: ReapDeps = {
      path,
      platform: 'darwin',
      env: {},
      graceMs: 2_000,
      inspect: async (pid) => {
        inspected.push(pid);
        return processes[pid] ?? null;
      },
      kill: (pid, signal) => {
        if (processes[pid] === undefined) return false;
        if (signal !== 0) signals.push([pid, signal]);
        if (signal === 'SIGKILL') delete processes[pid];
        return true;
      },
    };
    return { deps, signals, inspected, processes };
  }

  it('lives beside the other cache files', () => {
    expect(tunnelRecordPath('/home/someone')).toBe('/home/someone/.cache/cez/share-tunnels.json');
  });

  it('appends a tunnel with its port and the cezar that started it, readable by the user only', () => {
    expect(hasTunnelRecords(path)).toBe(false);
    recordTunnel(tunnel(100, 5001), path);
    recordTunnel(tunnel(101, 5002), path);
    expect(stored()).toEqual([tunnel(100, 5001), tunnel(101, 5002)]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(hasTunnelRecords(path)).toBe(true);
  });

  it('forgets a tunnel when its child exits, and keeps the others', () => {
    recordTunnel(tunnel(100, 5001), path);
    recordTunnel(tunnel(101, 5002), path);
    forgetTunnel(100, path);
    expect(stored()).toEqual([tunnel(101, 5002)]);
    forgetTunnel(101, path);
    expect(hasTunnelRecords(path)).toBe(false);
    forgetTunnel(999, path);
  });

  it('swallows every failure: a cache that cannot be written degrades to no record', () => {
    writeFileSync(join(dir, 'cache'), 'a file where the folder goes');
    expect(() => recordTunnel(tunnel(100, 5001), path)).not.toThrow();
    expect(() => forgetTunnel(100, path)).not.toThrow();
    expect(hasTunnelRecords(path)).toBe(false);
  });

  it('never writes the real cache from a test: without a path nothing is recorded', () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(recordTunnel(tunnel(100, 5001))).toBe(false);
    expect(forgetTunnel(100)).toBe(false);
    expect(hasTunnelRecords()).toBe(false);
    expect(recordTunnel(tunnel(100, 5001), path)).toBe(true);
  });

  it.each([
    ['is absent', null],
    ['is empty', ''],
    ['is not JSON', '{not json'],
    ['is not a list', '{"pid":1}'],
    ['holds nothing', '[]'],
    ['holds rows of another shape', '[{"pid":"1","port":2}]'],
  ])('has no records when the file %s', (_label, content) => {
    if (content !== null) {
      mkdirSync(join(dir, 'cache', 'cez'), { recursive: true });
      writeFileSync(path, content);
    }
    expect(hasTunnelRecords(path)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('reads a pid’s parent and command line from ps, and nothing for a pid that is gone', async () => {
    // This test process itself: the only pid it may ask about.
    const self = await inspectWithPs(process.pid);
    expect(self?.ppid).toBe(process.ppid);
    expect(self?.command).toContain(process.argv0.split('/').at(-1));
    expect(await inspectWithPs(2 ** 22 + 12345)).toBeNull();
  });

  describe('reapStaleTunnels', () => {
    it('ends a recorded tunnel whose cezar is gone: SIGTERM, then SIGKILL two seconds later if it is still there', async () => {
      vi.useFakeTimers();
      recordTunnel(tunnel(100, 5001), path);
      // Its parent is no longer the cezar that recorded it: that cezar died and the child was adopted.
      const { deps, signals } = world({ 100: { ppid: 1, command: cloudflared(5001) } });
      await reapStaleTunnels(deps);
      expect(signals).toEqual([[100, 'SIGTERM']]);
      expect(hasTunnelRecords(path)).toBe(false);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(signals).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals).toEqual([[100, 'SIGTERM'], [100, 'SIGKILL']]);
    });

    it('does not send SIGKILL to a tunnel that left on SIGTERM', async () => {
      vi.useFakeTimers();
      recordTunnel(tunnel(100, 5001), path);
      const { deps, signals, processes } = world({ 100: { ppid: 1, command: cloudflared(5001) } });
      await reapStaleTunnels(deps);
      delete processes[100];
      await vi.advanceTimersByTimeAsync(5_000);
      expect(signals).toEqual([[100, 'SIGTERM']]);
    });

    it('does not send SIGKILL when the pid was taken by another process meanwhile', async () => {
      vi.useFakeTimers();
      recordTunnel(tunnel(100, 5001), path);
      const { deps, signals, processes } = world({ 100: { ppid: 1, command: cloudflared(5001) } });
      await reapStaleTunnels(deps);
      processes[100] = { ppid: 1, command: '/usr/bin/vim notes.txt' };
      await vi.advanceTimersByTimeAsync(5_000);
      expect(signals).toEqual([[100, 'SIGTERM']]);
    });

    it.each([
      ['runs something else now (the pid was reused)', '/usr/bin/python3 server.py --url http://127.0.0.1:5001'],
      ['is a cloudflared for another port', cloudflared(5002)],
      ['is a cloudflared whose port only starts the same', cloudflared(50011)],
      ['is a cloudflared for another host', '/usr/bin/cloudflared tunnel --url http://10.0.0.1:5001'],
    ])('does not kill a pid that %s, and drops its entry', async (_label, command) => {
      recordTunnel(tunnel(100, 5001), path);
      const { deps, signals, inspected } = world({ 100: { ppid: 1, command } });
      await reapStaleTunnels(deps);
      expect(inspected).toEqual([100]);
      expect(signals).toEqual([]);
      expect(hasTunnelRecords(path)).toBe(false);
    });

    it('drops a dead pid without asking ps', async () => {
      recordTunnel(tunnel(100, 5001), path);
      const { deps, signals, inspected } = world({});
      await reapStaleTunnels(deps);
      expect(inspected).toEqual([]);
      expect(signals).toEqual([]);
      expect(hasTunnelRecords(path)).toBe(false);
    });

    it('leaves a tunnel whose parent is still the cezar that recorded it, and keeps its entry', async () => {
      // Another share of this cezar, or of a second cezar on this machine: live, not stale.
      recordTunnel(tunnel(100, 5001), path);
      recordTunnel(tunnel(101, 5002, 7777), path);
      recordTunnel(tunnel(102, 5003), path);
      const { deps, signals } = world({
        100: { ppid: OWNER, command: cloudflared(5001) },
        101: { ppid: 7777, command: cloudflared(5002) },
        102: { ppid: 1, command: cloudflared(5003) },
      });
      await reapStaleTunnels(deps);
      expect(signals).toEqual([[102, 'SIGTERM']]);
      expect(stored()).toEqual([tunnel(100, 5001), tunnel(101, 5002, 7777)]);
    });

    it('ends a matching tunnel recorded without its cezar', async () => {
      mkdirSync(join(dir, 'cache', 'cez'), { recursive: true });
      writeFileSync(path, JSON.stringify([{ pid: 100, port: 5001, startedAt: '2026-11-27T10:00:00.000Z' }]));
      const { deps, signals } = world({ 100: { ppid: 555, command: cloudflared(5001) } });
      await reapStaleTunnels(deps);
      expect(signals).toEqual([[100, 'SIGTERM']]);
    });

    it('ignores a corrupt file', async () => {
      mkdirSync(join(dir, 'cache', 'cez'), { recursive: true });
      writeFileSync(path, '{not json');
      const { deps, signals, inspected } = world({ 100: { ppid: 1, command: cloudflared(5001) } });
      await expect(reapStaleTunnels(deps)).resolves.toBeUndefined();
      expect(inspected).toEqual([]);
      expect(signals).toEqual([]);
    });

    it('asks nothing and signals nothing when the file is absent', async () => {
      const { deps, signals, inspected } = world({ 100: { ppid: 1, command: cloudflared(5001) } });
      await reapStaleTunnels(deps);
      expect(inspected).toEqual([]);
      expect(signals).toEqual([]);
      expect(existsSync(path)).toBe(false);
    });

    it('never kills on win32, where a pid cannot be checked: the entries are dropped', async () => {
      recordTunnel(tunnel(100, 5001), path);
      const { deps, signals, inspected } = world({ 100: { ppid: 1, command: cloudflared(5001) } });
      await reapStaleTunnels({ ...deps, platform: 'win32' });
      expect(inspected).toEqual([]);
      expect(signals).toEqual([]);
      expect(hasTunnelRecords(path)).toBe(false);
    });

    it('does nothing under CEZ_DRY_RUN=1', async () => {
      recordTunnel(tunnel(100, 5001), path);
      const { deps, signals, inspected } = world({ 100: { ppid: 1, command: cloudflared(5001) } });
      await reapStaleTunnels({ ...deps, env: { CEZ_DRY_RUN: '1' } });
      expect(inspected).toEqual([]);
      expect(signals).toEqual([]);
      expect(stored()).toEqual([tunnel(100, 5001)]);
    });

    it('does nothing under vitest unless the file, ps and kill are all injected', async () => {
      recordTunnel(tunnel(100, 5001), path);
      const { deps } = world({ 100: { ppid: 1, command: cloudflared(5001) } });
      for (const missing of ['path', 'inspect', 'kill'] as const) {
        const partial: ReapDeps = { ...deps, env: { VITEST: 'true' } };
        delete partial[missing];
        await reapStaleTunnels(partial);
      }
      await reapStaleTunnels();
      expect(stored()).toEqual([tunnel(100, 5001)]);
    });

    it('never throws, whatever ps and kill do', async () => {
      recordTunnel(tunnel(100, 5001), path);
      recordTunnel(tunnel(101, 5002), path);
      const { deps } = world({ 100: { ppid: 1, command: cloudflared(5001) } });
      await expect(
        reapStaleTunnels({
          ...deps,
          inspect: async () => {
            throw new Error('ps is missing');
          },
          kill: (_pid, signal) => {
            if (signal !== 0) throw new Error('EPERM');
            return true;
          },
        }),
      ).resolves.toBeUndefined();
      // Unjudged: not killed, and not kept either.
      expect(hasTunnelRecords(path)).toBe(false);
    });
  });
});
