import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable } from 'node:stream';

import { resolveOnPath } from '../open-in-app.ts';
import { TunnelError, type Tunnel, type TunnelAdapter } from './share-listener.ts';

/**
 * Tunnel adapters (spec 2026-11-26-preview-share-link § Mechanism 3): `cloudflared`'s quick tunnel
 * as a child process, and a loopback stand-in for `CEZ_DRY_RUN=1`.
 */

/** The one child this needs. `onExit` fires once; `reason` is set for an exit that was not a spawn error. */
export interface TunnelChild {
  onLine(listener: (line: string) => void): void;
  onExit(listener: (error?: Error, reason?: string) => void): void;
  kill(): void;
}

export interface CloudflaredOptions {
  resolve?(bin: string): string | null;
  spawn?(bin: string, args: readonly string[]): TunnelChild;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

const ADDRESS = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const START_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const TAIL_LINES = 20;
const TAIL_LINE_CHARS = 500;
const MESSAGE_CHARS = 300;
const STOPPED = 'Sharing was stopped';

export function installHint(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'brew install cloudflared';
  if (platform === 'win32') return 'winget install --id Cloudflare.cloudflared';
  return 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

/** Every live child, so one process `exit` listener can end them all (spec § Exposure, a stray child). */
const live = new Set<() => void>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const kill of live) kill();
  });
}

function splitLines(stream: Readable | null, emit: (line: string) => void): void {
  if (!stream) return;
  stream.setEncoding('utf8');
  let rest = '';
  const push = (line: string): void => emit(line.endsWith('\r') ? line.slice(0, -1) : line);
  stream.on('data', (chunk: string) => {
    rest += chunk;
    let at = rest.indexOf('\n');
    while (at >= 0) {
      push(rest.slice(0, at));
      rest = rest.slice(at + 1);
      at = rest.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (rest !== '') push(rest);
    rest = '';
  });
  stream.on('error', () => {});
}

const spawnCloudflared = (bin: string, args: readonly string[]): TunnelChild => {
  // A test process never opens a public tunnel.
  if (process.env.VITEST) throw new TunnelError('cloudflared is not started under test', 'tunnel-failed');
  const child = nodeSpawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const lineListeners: Array<(line: string) => void> = [];
  const emit = (line: string): void => {
    for (const listener of lineListeners) listener(line);
  };
  splitLines(child.stdout, emit);
  splitLines(child.stderr, emit);
  let escalate: NodeJS.Timeout | undefined;
  const gone = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const kill = (): void => {
    if (gone()) return;
    child.kill('SIGTERM');
    escalate ??= setTimeout(() => {
      if (!gone()) child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    escalate.unref();
  };
  installExitHook();
  live.add(kill);
  return {
    onLine: (listener) => { lineListeners.push(listener); },
    kill,
    onExit: (listener) => {
      let done = false;
      const once = (error?: Error, reason?: string): void => {
        if (done) return;
        done = true;
        live.delete(kill);
        if (escalate) clearTimeout(escalate);
        listener(error, reason);
      };
      child.once('error', (error) => once(error));
      // `close`, not `exit`: the last output line is read before the exit is reported.
      child.once('close', (code, signal) =>
        once(undefined, signal ? `killed by ${signal}` : `exited with code ${code ?? 'unknown'}`));
    },
  };
};

export function cloudflaredTunnel(options: CloudflaredOptions = {}): TunnelAdapter {
  const resolve = options.resolve ?? ((bin: string) => resolveOnPath(bin));
  const spawn = options.spawn ?? spawnCloudflared;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;

  return {
    start(port, signal) {
      return new Promise<Tunnel>((resolveStart, rejectStart) => {
        if (signal?.aborted) {
          rejectStart(new TunnelError(STOPPED, 'tunnel-failed'));
          return;
        }
        const bin = resolve('cloudflared');
        if (!bin) {
          rejectStart(new TunnelError('Sharing needs cloudflared', 'no-tunnel', installHint(platform)));
          return;
        }
        let child: TunnelChild;
        try {
          child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`]);
        } catch (error) {
          rejectStart(error instanceof TunnelError
            ? error
            : new TunnelError(error instanceof Error ? error.message : 'cloudflared did not start', 'tunnel-failed'));
          return;
        }

        const tail: string[] = [];
        const listeners: Array<(reason: string) => void> = [];
        let settled = false;
        let stopped = false;
        let timer: NodeJS.Timeout | undefined;

        const lastLine = (): string => (tail.at(-1) ?? 'cloudflared did not start').slice(0, MESSAGE_CHARS);
        const finish = (): void => {
          settled = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const fail = (message: string): void => {
          if (settled) return;
          finish();
          child.kill();
          rejectStart(new TunnelError(message, 'tunnel-failed'));
        };
        function onAbort(): void {
          fail(STOPPED);
        }

        child.onLine((line) => {
          if (line.trim() === '') return;
          tail.push(line.slice(0, TAIL_LINE_CHARS));
          if (tail.length > TAIL_LINES) tail.shift();
          if (settled) return;
          const found = ADDRESS.exec(line);
          if (!found) return;
          finish();
          resolveStart({
            origin: found[0],
            stop: () => {
              stopped = true;
              child.kill();
            },
            onExit: (listener) => { listeners.push(listener); },
          });
        });
        child.onExit((error, reason) => {
          if (!settled) {
            fail(error ? error.message : lastLine());
            return;
          }
          if (stopped) return;
          const why = error ? error.message : (reason ?? 'exited');
          for (const listener of listeners.splice(0)) listener(why);
        });

        timer = setTimeout(() => fail(lastLine()), timeoutMs);
        timer.unref();
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

/** Only for `CEZ_DRY_RUN=1`: the share listener binds 127.0.0.1, so nothing is exposed. */
export function loopbackTunnel(): TunnelAdapter {
  return {
    start(port, signal) {
      if (signal?.aborted) return Promise.reject(new TunnelError(STOPPED, 'tunnel-failed'));
      return Promise.resolve({
        origin: `http://127.0.0.1:${port}`,
        stop: () => {},
        onExit: () => {},
      });
    },
  };
}

export function shareTunnel(env: NodeJS.ProcessEnv): TunnelAdapter {
  return env.CEZ_DRY_RUN === '1' ? loopbackTunnel() : cloudflaredTunnel();
}
