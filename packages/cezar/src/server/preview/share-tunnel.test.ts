import { afterEach, describe, expect, it, vi } from 'vitest';

import { TunnelError } from './share-listener.ts';
import { cloudflaredTunnel, installHint, loopbackTunnel, shareTunnel, type TunnelChild } from './share-tunnel.ts';

class FakeChild implements TunnelChild {
  killed = 0;
  private lines: Array<(line: string) => void> = [];
  private exits: Array<(error?: Error, reason?: string) => void> = [];
  onLine(l: (line: string) => void): void { this.lines.push(l); }
  onExit(l: (error?: Error, reason?: string) => void): void { this.exits.push(l); }
  kill(): void { this.killed += 1; }
  line(text: string): void { for (const l of this.lines) l(text); }
  exit(reason = 'exited with code 1', error?: Error): void { for (const l of this.exits) l(error, reason); }
}

function setup(options: { timeoutMs?: number } = {}) {
  const child = new FakeChild();
  const spawned: { bin?: string; args?: readonly string[]; count: number } = { count: 0 };
  const adapter = cloudflaredTunnel({
    resolve: () => 'cloudflared',
    spawn: (bin, args) => { spawned.bin = bin; spawned.args = args; spawned.count += 1; return child; },
    ...options,
  });
  return { child, spawned, adapter };
}

afterEach(() => { vi.useRealTimers(); });

describe('cloudflaredTunnel', () => {
  it('resolves with the trycloudflare address from the output', async () => {
    const { child, spawned, adapter } = setup();
    const t = adapter.start(4321);
    child.line('2026-11-26 INF |  https://calm-river-12.trycloudflare.com  |');
    expect((await t).origin).toBe('https://calm-river-12.trycloudflare.com');
    expect(spawned.args).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4321']);
  });

  it('rejects with the install command when cloudflared is not on PATH', async () => {
    await expect(cloudflaredTunnel({ resolve: () => null, platform: 'darwin' }).start(1))
      .rejects.toMatchObject({ code: 'no-tunnel', install: 'brew install cloudflared' });
  });

  it('rejects with the last output line when the child exits first', async () => {
    const { child, adapter } = setup();
    const t = adapter.start(1);
    child.line('first');
    child.line('');
    child.line('ERR Cannot determine default configuration path');
    child.exit();
    await expect(t).rejects.toMatchObject({ code: 'tunnel-failed', message: 'ERR Cannot determine default configuration path' });
  });

  it('falls back to a fixed message when the child said nothing', async () => {
    const { child, adapter } = setup();
    const t = adapter.start(1);
    child.exit();
    await expect(t).rejects.toMatchObject({ code: 'tunnel-failed', message: 'cloudflared did not start' });
  });

  it('cuts the message to 300 characters', async () => {
    const { child, adapter } = setup();
    const t = adapter.start(1);
    child.line('x'.repeat(900));
    child.exit();
    await expect(t).rejects.toSatisfy((e: Error) => e.message.length === 300);
  });

  it('kills the child and rejects after 30 seconds without an address', async () => {
    vi.useFakeTimers();
    const { child, adapter } = setup();
    const t = adapter.start(1);
    const outcome = expect(t).rejects.toMatchObject({ code: 'tunnel-failed', message: 'starting' });
    child.line('starting');
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
    expect(child.killed).toBe(1);
  });

  it('rejects with the error message when the spawn fails, without hanging', async () => {
    const { child, adapter } = setup();
    const t = adapter.start(1);
    child.exit(undefined, new Error('spawn cloudflared EACCES'));
    await expect(t).rejects.toMatchObject({ code: 'tunnel-failed', message: 'spawn cloudflared EACCES' });
  });

  it('rejects when spawn itself throws', async () => {
    const adapter = cloudflaredTunnel({ resolve: () => 'cloudflared', spawn: () => { throw new Error('boom'); } });
    await expect(adapter.start(1)).rejects.toMatchObject({ code: 'tunnel-failed', message: 'boom' });
  });

  it('reports an exit after start once, with the reason', async () => {
    const { child, adapter } = setup();
    const t = adapter.start(1);
    child.line('https://a-b.trycloudflare.com');
    const tunnel = await t;
    const reasons: string[] = [];
    tunnel.onExit((r) => reasons.push(r));
    child.exit('exited with code 7');
    child.exit('exited with code 8');
    expect(reasons).toEqual(['exited with code 7']);
  });

  it('does not report a stop()', async () => {
    const { child, adapter } = setup();
    const t = adapter.start(1);
    child.line('https://a-b.trycloudflare.com');
    const tunnel = await t;
    const reasons: string[] = [];
    tunnel.onExit((r) => reasons.push(r));
    tunnel.stop();
    child.exit('killed by SIGTERM');
    expect(child.killed).toBe(1);
    expect(reasons).toEqual([]);
  });

  it('kills the child and rejects when the signal aborts before an address', async () => {
    const { child, adapter } = setup();
    const abort = new AbortController();
    const t = adapter.start(1, abort.signal);
    abort.abort();
    await expect(t).rejects.toBeInstanceOf(TunnelError);
    expect(child.killed).toBe(1);
  });

  it('does not spawn when the signal is already aborted', async () => {
    const { spawned, adapter } = setup();
    await expect(adapter.start(1, AbortSignal.abort())).rejects.toBeInstanceOf(TunnelError);
    expect(spawned.count).toBe(0);
  });

  it('ignores the signal once the address is known', async () => {
    const { child, adapter } = setup();
    const abort = new AbortController();
    const t = adapter.start(1, abort.signal);
    child.line('https://a-b.trycloudflare.com');
    await t;
    abort.abort();
    expect(child.killed).toBe(0);
  });

  it('never starts a real process under vitest', async () => {
    await expect(cloudflaredTunnel({ resolve: () => 'cloudflared' }).start(1))
      .rejects.toMatchObject({ code: 'tunnel-failed', message: 'cloudflared is not started under test' });
  });
});

describe('loopbackTunnel and shareTunnel', () => {
  it('answers with the loopback origin and a no-op stop', async () => {
    const tunnel = await loopbackTunnel().start(5000);
    expect(tunnel.origin).toBe('http://127.0.0.1:5000');
    tunnel.onExit(() => { throw new Error('never'); });
    expect(() => tunnel.stop()).not.toThrow();
  });

  it('honours an aborted signal', async () => {
    await expect(loopbackTunnel().start(1, AbortSignal.abort())).rejects.toBeInstanceOf(TunnelError);
  });

  it('picks loopback only under CEZ_DRY_RUN=1', async () => {
    expect((await shareTunnel({ CEZ_DRY_RUN: '1' }).start(9)).origin).toBe('http://127.0.0.1:9');
    await expect(shareTunnel({}).start(9)).rejects.toBeInstanceOf(TunnelError);
  });
});

describe('installHint', () => {
  it('names the install per platform', () => {
    expect(installHint('darwin')).toBe('brew install cloudflared');
    expect(installHint('win32')).toBe('winget install --id Cloudflare.cloudflared');
    expect(installHint('linux')).toMatch(/^https:\/\/developers\.cloudflare\.com\//);
  });
});
