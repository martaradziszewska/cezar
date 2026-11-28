import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { runInNewContext } from 'node:vm';
import { GUEST_COMMENT_OVERHEAD, GUEST_COMMENTS_MAX, GUEST_COMMENTS_TEXT_BUDGET, type GuestComment } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addGuestComment, guestCommentsRoot, readGuestComments } from '../../runs/guest-comments.ts';
import { artifactsDir } from '../../runs/store.ts';
import { artifactCsp } from '../artifacts.ts';
import { createGuestRoutes } from './share-guest-routes.ts';
import { AssetShares, type GuestRequest, type GuestRoutes, type Tunnel, type TunnelAdapter } from './share-listener.ts';

/**
 * What the share listener answers with (spec `.ai/specs/2026-11-28-asset-share-link.md` § Mechanism 3–9,
 * § Storage, § Exposure). The routes run behind the real listener and a fake tunnel that hands the
 * listener's own address back, so every rule is decided on a real socket, cookie and guest state.
 */

const SHARE = '/__cezar_share__';
const ASSET = 'settings-mockup.html';
const TITLE = 'Settings mockup';
const GONE = 'This link is no longer active.';
const INBOX_FULL = "The reviewer's inbox is full.";
const BODY_MAX = 64 * 1024;
const ASK_MAX = 1024;
const MINUTE = 60_000;
const NOT_ALLOWED = ['new', 'waiting', 'denied', 'expired'] as const;
const EVERY_STATE = ['new', 'waiting', 'allowed', 'denied', 'expired'] as const;
type State = (typeof EVERY_STATE)[number];

interface Body {
  comment: GuestComment;
  comments: GuestComment[];
  error?: string;
  code?: string;
  state?: string;
  name?: string;
}
interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: Body;
}
interface Site {
  runId: string;
  port: number;
  host: string;
  origin: string;
  joinPath: string;
}
type Headers = Record<string, string | undefined>;

function send(port: number, host: string, path: string, init: { method?: string; headers?: Headers; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (value !== undefined) headers[name] = value;
    }
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          get json() {
            return JSON.parse(body) as Body;
          },
        });
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

/** A request written by hand and never ended; resolves only once the SERVER closes the socket. */
function unfinished(site: Site, lines: string[], body = ''): Promise<{ status: number }> {
  return new Promise((resolve) => {
    const socket = connect(site.port, '127.0.0.1');
    let text = '';
    socket.on('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`));
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0) }));
  });
}

/** A request whose body the test finishes, or abandons, when it chooses. `answered` is false when the socket closed first. */
function stalled(site: Site, lines: string[], firstPart: string): { socket: Socket; settled: Promise<{ answered: boolean; text: string }> } {
  const socket = connect(site.port, '127.0.0.1');
  let text = '';
  const settled = new Promise<{ answered: boolean; text: string }>((resolve) => {
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (text.includes('\r\n\r\n')) resolve({ answered: true, text });
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve({ answered: false, text }));
  });
  socket.on('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n${firstPart}`));
  return { socket, settled };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !done(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  if (!done()) throw new Error('it never happened');
}

class LoopbackTunnel implements TunnelAdapter {
  started: number[] = [];
  async start(port: number): Promise<Tunnel> {
    this.started.push(port);
    return { origin: `http://127.0.0.1:${port}`, stop: () => {}, onExit: () => {} };
  }
}

const idOf = (cookie: string): string => createHash('sha256').update(cookie).digest('hex').slice(0, 16);

describe('the share listener’s own pages', () => {
  let dir: string;
  let clock: number;
  let tunnels: LoopbackTunnel;
  let shares: AssetShares;
  let routes: GuestRoutes;
  let published: Array<[string, string]>;
  /** Every shell the routes asked for, in order. */
  let shells: Array<{ name: string; frameSrc: string; nonce: string; title: string }>;
  /** `CEZ_ARTIFACTS_CDN`, as the routes read it per answer. */
  let cdn: boolean;
  let onComments: (projectId: string, runId: string) => void;
  let main: Site;
  let addresses: number;
  /** Every request the listener handed to the routes, in order. */
  let handed: string[];
  let others: AssetShares[];

  beforeEach(async () => {
    published = [];
    shells = [];
    cdn = true;
    addresses = 0;
    handed = [];
    others = [];
    clock = Date.now();
    onComments = (projectId, runId) => published.push([projectId, runId]);
    dir = mkdtempSync(joinPath(tmpdir(), 'cez-share-guest-'));
    routes = buildRoutes();
    tunnels = new LoopbackTunnel();
    shares = buildShares(routes);
    main = await open('r1', 'p1');
  });

  function buildRoutes(bodyTimeoutMs?: number): GuestRoutes {
    return createGuestRoutes({
      dataDirOf: (projectId) => (projectId === 'p1' ? dir : null),
      onComments: (projectId, runId) => onComments(projectId, runId),
      guestShell: (config) => {
        shells.push(config);
        return `<!-- shell ${JSON.stringify(config)} -->`;
      },
      cdnEnabled: () => cdn,
      now: () => clock,
      ...(bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs }),
    });
  }

  function buildShares(guestRoutes: GuestRoutes): AssetShares {
    const built = new AssetShares({
      tunnel: tunnels,
      guestRoutes: {
        handle(ctx, req, res) {
          handed.push(`${req.method} ${ctx.path}`);
          return guestRoutes.handle(ctx, req, res);
        },
        shell: (ctx, req, res) => guestRoutes.shell(ctx, req, res),
        asset: (ctx, name, req, res) => guestRoutes.asset(ctx, name, req, res),
      },
      onChange: () => {},
      now: () => clock,
    });
    others.push(built);
    return built;
  }

  afterEach(() => {
    for (const built of others) built.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(runId: string, projectId: string, on: AssetShares = shares): Promise<Site> {
    const started = await on.start({ runId, projectId, asset: ASSET, assetTitle: TITLE });
    if (!started.ok) throw new Error(started.error);
    const url = new URL(started.share.url);
    return { runId, port: tunnels.started.at(-1)!, host: url.host, origin: url.origin, joinPath: url.pathname + url.search };
  }

  /** One browser: its cookie on every request, and on a write what a browser adds for a same-origin fetch. */
  function browser(cookie: string, site: Site = main) {
    const call = (method: string, path: string, body?: unknown, headers: Headers = {}): Promise<Answer> =>
      send(site.port, site.host, `${SHARE}/${path}`, {
        method,
        headers: {
          cookie: `theme=dark; __cezar_share=${cookie}`,
          ...(method === 'GET' ? {} : { origin: site.origin, 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
    return {
      cookie,
      id: idOf(cookie),
      site,
      call,
      get: (path: string, headers?: Headers) => call('GET', path, undefined, headers),
      post: (path: string, body?: unknown, headers?: Headers) => call('POST', path, body, headers),
      put: (path: string, body?: unknown, headers?: Headers) => call('PUT', path, body, headers),
      delete: (path: string, headers?: Headers) => call('DELETE', path, undefined, headers),
    };
  }
  type Browser = ReturnType<typeof browser>;

  async function join(site: Site = main): Promise<Browser> {
    const res = await send(site.port, site.host, site.joinPath, { headers: { 'cf-connecting-ip': `198.51.100.${(addresses += 1)}` } });
    const cookie = /__cezar_share=([a-f0-9]{64})/.exec(String(res.headers['set-cookie']));
    if (res.status !== 302 || cookie === null) throw new Error(`join answered ${res.status}`);
    return browser(cookie[1]!, site);
  }

  /** A browser brought to `state` the way a real one gets there. `expired` moves the clock for everyone. */
  async function guestIn(state: State, name = 'Ana', site: Site = main, on: AssetShares = shares): Promise<Browser> {
    const guest = await join(site);
    if (state === 'new') return guest;
    expect((await guest.post('ask', { name })).status).toBe(200);
    if (state === 'allowed') expect(on.decide(site.runId, guest.id, 'allow')).toBe(true);
    if (state === 'denied') expect(on.decide(site.runId, guest.id, 'deny')).toBe(true);
    if (state === 'expired') clock += 10 * MINUTE;
    expect((await guest.get('status')).json.state).toBe(state);
    return guest;
  }

  /** `GET /` as this browser: the shell for an allowed one. */
  const shellOf = (guest: Browser): Promise<Answer> =>
    send(guest.site.port, guest.site.host, '/', { headers: { cookie: `theme=dark; __cezar_share=${guest.cookie}` } });

  const comment = () => ({
    selector: 'main > form.settings > button.btn-primary',
    label: 'Save',
    excerpt: '<button class="btn-primary" type="submit">Save</button>',
    body: 'Make this the brand green.',
  });

  const stored = (runId = 'r1') => readGuestComments(dir, runId);

  function expectUncacheable(res: Answer): void {
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['cdn-cache-control']).toBe('no-store');
  }

  function expectJson(res: Answer): void {
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  }

  function expectGone(res: Answer): void {
    expect(res.status).toBe(404);
    expectJson(res);
    expect(res.json).toEqual({ error: GONE });
  }

  describe('the waiting page', () => {
    it.each(EVERY_STATE)('is served to a %s browser', async (state) => {
      const res = await (await guestIn(state)).get('wait');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.body.startsWith('<!doctype html>')).toBe(true);
    });

    it('carries the wording a visitor reads', async () => {
      const { body } = await (await join()).get('wait');
      for (const text of [
        'Someone is sharing a design with you.',
        '<title>Shared design</title>',
        'Your name',
        'Ask to join',
        'Waiting to be let in…',
        'Your code: ',
        'You were not let in.',
        'Nobody answered in time.',
        'Ask again',
      ]) {
        expect(body).toContain(text);
      }
    });

    it('makes no external request: inline script and style only', async () => {
      const { body } = await (await join()).get('wait');
      expect(body).not.toMatch(/(src|href)="https?:/);
      expect(body).not.toMatch(/\b(src|href|srcset|action|formaction|poster|background)\s*=/i);
      expect(body).not.toMatch(/<(link|img|iframe|object|embed|base|form[^>]*\saction)\b/i);
      expect(body).not.toMatch(/url\(|@import|https?:\/\//i);
    });

    it('is sent under a strict policy with a fresh nonce on every element that runs or styles', async () => {
      const guest = await join();
      const first = await guest.get('wait');
      const second = await guest.get('wait');
      const policy = /^default-src 'none'; script-src 'nonce-([A-Za-z0-9+/=]{22,})'; style-src 'nonce-\1'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/;
      const nonce = policy.exec(String(first.headers['content-security-policy']))?.[1];
      expect(nonce).toBeDefined();
      expect(policy.exec(String(second.headers['content-security-policy']))?.[1]).not.toBe(nonce);
      expect(first.headers['x-content-type-options']).toBe('nosniff');
      expect(first.headers['referrer-policy']).toBe('no-referrer');

      const scripts = [...first.body.matchAll(/<script\b([^>]*)>/g)].map((tag) => tag[1]!.trim());
      expect(scripts).toEqual([`nonce="${nonce}"`]);
      expect([...first.body.matchAll(/<style\b([^>]*)>/g)].map((tag) => tag[1]!.trim())).toEqual([`nonce="${nonce}"`]);
      // What the policy would refuse anyway must not be relied on: no handler or style attribute at all.
      expect(first.body).not.toMatch(/<[^>]+\s(on[a-z]+|style)\s*=/i);
    });

    it('never builds markup from a string', async () => {
      const { body } = await (await join()).get('wait');
      expect(body).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/);
    });

    it('follows the visitor’s light or dark setting', async () => {
      const { body } = await (await join()).get('wait');
      expect(body).toContain('@media (prefers-color-scheme: dark)');
    });

    it('asks on Enter: the name field and the button are one form', async () => {
      const { body } = await (await join()).get('wait');
      const form = /<form id="ask">([\s\S]*?)<\/form>/.exec(body)?.[1] ?? '';
      expect(form).toMatch(/<label for="name">Your name<\/label>/);
      expect(form).toMatch(/<input id="name"[^>]*>/);
      expect(form).toMatch(/<button id="submit" type="submit">Ask to join<\/button>/);
    });

    it('carries nothing from its address: a next is ignored', async () => {
      const guest = await join();
      const { body } = await guest.get(`wait?next=${encodeURIComponent('//evil.example/</script><script>alert(1)</script>')}`);
      expect(body).not.toContain('evil.example');
      expect(body).not.toContain('alert(1)');
      expect(body.match(/<script\b/g)).toHaveLength(1);
      expect(body.match(/<\/script>/g)).toHaveLength(1);
    });

    it('is never kept by a shared cache', async () => {
      expectUncacheable(await (await join()).get('wait'));
    });

    describe('in a browser', () => {
      interface Fake {
        hidden: boolean;
        disabled: boolean;
        value: string;
        textContent: string;
        focus(): void;
        addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void;
        fire(type: string): void;
      }

      /**
       * Runs the page's own script against the real routes: `fetch` goes to the listener with the
       * `Origin` a browser adds to a same-origin write and nothing else the page did not send itself.
       */
      async function load(guest: Browser, query = '') {
        const html = (await guest.get(`wait${query}`)).body;
        const elements = new Map<string, Fake>();
        for (const tag of html.matchAll(/<[a-z0-9]+\b([^>]*)\bid="([^"]+)"([^>]*)>([^<]*)/g)) {
          const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
          const fake: Fake = {
            hidden: /\shidden\b/.test(`${tag[1]}${tag[3]}`),
            disabled: false,
            value: '',
            textContent: tag[4]!,
            focus: () => {},
            addEventListener: (type, listener) => listeners.set(type, listener),
            fire: (type) => listeners.get(type)?.({ preventDefault: () => {} }),
          };
          Object.defineProperty(fake, 'innerHTML', {
            set: () => {
              throw new Error('the page wrote markup');
            },
          });
          elements.set(tag[2]!, fake);
        }
        const requests: string[] = [];
        const visited: string[] = [];
        const timers = new Map<number, { run: () => void; ms: number }>();
        let timerId = 0;
        let offline = false;
        let inFlight = 0;
        /** Until the page has no request out and has started no new one. */
        const flush = async (): Promise<void> => {
          for (let quiet = 0; quiet < 2; quiet = inFlight === 0 ? quiet + 1 : 0) await new Promise((resolve) => setImmediate(resolve));
        };
        runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!, {
          document: { getElementById: (id: string) => elements.get(id) ?? null },
          location: { replace: (url: string) => visited.push(url) },
          setTimeout: (run: () => void, ms: number) => {
            timers.set((timerId += 1), { run, ms });
            return timerId;
          },
          clearTimeout: (id: number) => timers.delete(id),
          fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
            requests.push(`${init.method ?? 'GET'} ${url}`);
            if (offline) throw new TypeError('Failed to fetch');
            if (!url.startsWith(`${SHARE}/`)) throw new Error(`the page asked for ${url}`);
            inFlight += 1;
            try {
              const res = await guest.call(init.method ?? 'GET', url.slice(SHARE.length + 1), init.body, { 'content-type': undefined, ...init.headers });
              return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.json };
            } finally {
              inFlight -= 1;
            }
          },
        });
        await flush();
        return {
          requests,
          visited,
          timers,
          el: (id: string): Fake => elements.get(id)!,
          setOffline: (value: boolean) => {
            offline = value;
          },
          async click(id: string): Promise<void> {
            elements.get(id)!.fire('click');
            await flush();
          },
          async ask(name: string): Promise<void> {
            elements.get('name')!.value = name;
            elements.get('ask')!.fire('submit');
            await flush();
          },
          /** Runs the one pending poll, as its timer would. */
          async poll(): Promise<void> {
            const pending = [...timers.entries()];
            expect(pending).toHaveLength(1);
            timers.delete(pending[0]![0]);
            pending[0]![1].run();
            await flush();
          },
        };
      }

      it('shows the name field first, and asks nothing on its own', async () => {
        const guest = await join();
        const page = await load(guest);
        expect(page.requests).toEqual([`GET ${SHARE}/status`]);
        expect(page.el('ask').hidden).toBe(false);
        expect(page.el('waiting').hidden).toBe(true);
        expect(page.el('message').hidden).toBe(true);
        expect(page.el('again').hidden).toBe(true);
        expect(page.timers.size).toBe(0);
        expect(shares.get('r1')!.guests).toEqual([]);
      });

      it('asks with the typed name, then shows the name and the code the server kept', async () => {
        const guest = await join();
        const page = await load(guest);
        await page.ask('  Ana\n Kowalska ');
        expect(page.requests).toEqual([`GET ${SHARE}/status`, `POST ${SHARE}/ask`, `GET ${SHARE}/status`]);
        const listed = shares.get('r1')!.guests;
        expect(listed).toMatchObject([{ id: guest.id, name: 'Ana Kowalska', state: 'waiting' }]);
        expect(page.el('waiting').hidden).toBe(false);
        expect(page.el('code').textContent).toBe(`Your code: ${listed[0]!.code}`);
        expect(page.el('name').value).toBe('Ana Kowalska');
        expect(page.el('name').disabled).toBe(true);
        expect(page.el('submit').disabled).toBe(true);
      });

      it('checks every 2 seconds while waiting and goes to the shell once let in', async () => {
        const guest = await join();
        const page = await load(guest);
        await page.ask('Ana');
        expect([...page.timers.values()].map((timer) => timer.ms)).toEqual([2000]);
        await page.poll();
        expect(page.visited).toEqual([]);
        expect([...page.timers.values()].map((timer) => timer.ms)).toEqual([2000]);
        shares.decide('r1', guest.id, 'allow');
        await page.poll();
        expect(page.visited).toEqual(['/']);
        expect(page.timers.size).toBe(0);
      });

      it('sends a browser that is already let in straight to the shell, whatever next says', async () => {
        const page = await load(await guestIn('allowed'), '?next=%2F%2Fevil.example');
        expect(page.visited).toEqual(['/']);
      });

      it('tells a denied visitor so and stops checking', async () => {
        const guest = await join();
        const page = await load(guest);
        await page.ask('Ana');
        shares.decide('r1', guest.id, 'deny');
        await page.poll();
        expect(page.el('message').textContent).toBe('You were not let in.');
        expect(page.el('message').hidden).toBe(false);
        expect(page.el('ask').hidden).toBe(true);
        expect(page.el('waiting').hidden).toBe(true);
        expect(page.el('again').hidden).toBe(true);
        expect(page.timers.size).toBe(0);
        expect(page.visited).toEqual([]);
      });

      it('offers Ask again when nobody answered, and asks with the same name', async () => {
        const guest = await join();
        const page = await load(guest);
        await page.ask('Ana');
        const first = shares.get('r1')!.guests[0]!.code;
        clock += 10 * MINUTE;
        await page.poll();
        expect(page.el('message').textContent).toBe('Nobody answered in time.');
        expect(page.el('again').hidden).toBe(false);
        expect(page.el('again').textContent).toBe('Ask again');
        expect(page.el('ask').hidden).toBe(true);
        expect(page.timers.size).toBe(0);

        await page.click('again');
        expect(shares.get('r1')!.guests).toMatchObject([{ id: guest.id, name: 'Ana', state: 'waiting' }]);
        expect(page.el('again').hidden).toBe(true);
        expect(page.el('message').hidden).toBe(true);
        expect(page.el('waiting').hidden).toBe(false);
        expect(page.el('code').textContent).toMatch(/^Your code: \d{4}$/);
        expect(first).toMatch(/^\d{4}$/);
      });

      it('shows the server’s own words when asking is refused', async () => {
        for (const name of ['A', 'B', 'C', 'D', 'E']) await guestIn('waiting', name);
        const page = await load(await join());
        await page.ask('Ana');
        expect(page.el('message').textContent).toBe('Too many people are waiting to be let in. Try again in a few minutes.');
        expect(page.el('message').hidden).toBe(false);
        expect(page.el('ask').hidden).toBe(false);
        expect(page.el('submit').disabled).toBe(false);
        expect(page.el('name').value).toBe('Ana');
      });

      it('keeps checking through a failed request, and gives up on a link that stays dead', async () => {
        const guest = await join();
        const page = await load(guest);
        await page.ask('Ana');
        page.setOffline(true);
        await page.poll();
        expect(page.el('waiting').hidden).toBe(false);
        page.setOffline(false);
        shares.decide('r1', guest.id, 'allow');
        await page.poll();
        expect(page.visited).toEqual(['/']);

        const stale = await load(await guestIn('waiting', 'Piotr'));
        stale.setOffline(true);
        for (let i = 0; i < 30; i += 1) await stale.poll();
        expect(stale.timers.size).toBe(0);
        expect(stale.el('message').textContent).toBe(GONE);
        expect(stale.el('ask').hidden).toBe(true);
      });
    });
  });

  describe('GET status', () => {
    it('answers only the state before a name was given', async () => {
      const res = await (await guestIn('new')).get('status');
      expect(res.status).toBe(200);
      expectJson(res);
      expectUncacheable(res);
      expect(res.json).toEqual({ state: 'new' });
    });

    it.each(['waiting', 'allowed', 'denied', 'expired'] as const)('answers a %s browser its state, name and code, and nothing else', async (state) => {
      const guest = await guestIn(state, 'Ana');
      const res = await guest.get('status');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ state, name: 'Ana', code: expect.stringMatching(/^\d{4}$/) });
      expect(res.body).not.toContain(guest.cookie);
      expect(res.body).not.toContain(guest.id);
    });

    it('never tells one browser about another', async () => {
      await guestIn('waiting', 'Piotr');
      expect((await (await join()).get('status')).json).toEqual({ state: 'new' });
    });
  });

  describe('POST ask', () => {
    it('gives a new browser a 4-digit code and lists its request for the owner', async () => {
      const guest = await join();
      const res = await guest.post('ask', { name: 'Ana' });
      expect(res.status).toBe(200);
      expectJson(res);
      expect(res.json).toEqual({ code: expect.stringMatching(/^\d{4}$/) });
      expect(shares.get('r1')!.guests).toMatchObject([{ id: guest.id, name: 'Ana', code: res.json.code, state: 'waiting' }]);
    });

    it('lets a browser whose request expired ask again', async () => {
      const guest = await guestIn('expired');
      expect(shares.get('r1')!.guests).toEqual([]);
      const res = await guest.post('ask', { name: 'Ana' });
      expect(res.status).toBe(200);
      expect((await guest.get('status')).json).toMatchObject({ state: 'waiting', code: res.json.code });
    });

    it('answers 409 with the reason to a denied browser, which stays denied', async () => {
      const guest = await guestIn('denied');
      const res = await guest.post('ask', { name: 'Ana again' });
      expect(res.status).toBe(409);
      expectJson(res);
      expect(res.json).toEqual({ error: 'The owner declined this request.' });
      expect((await guest.get('status')).json.state).toBe('denied');
    });

    it.each(['waiting', 'allowed'] as const)('changes nothing for a %s browser: the same code, the first name', async (state) => {
      const guest = await guestIn(state, 'Ana');
      const { code } = (await guest.get('status')).json;
      const res = await guest.post('ask', { name: 'Marta' });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ code });
      expect((await guest.get('status')).json).toEqual({ state, name: 'Ana', code });
    });

    it('answers 409 to a name with nothing in it, and to a sixth request while five wait', async () => {
      const guest = await join();
      const empty = await guest.post('ask', { name: ' \n ' });
      expect(empty.status).toBe(409);
      expect(empty.json).toEqual({ error: 'Enter your name.' });
      for (const name of ['A', 'B', 'C', 'D', 'E']) await guestIn('waiting', name);
      const sixth = await guest.post('ask', { name: 'Ana' });
      expect(sixth.status).toBe(409);
      expect(sixth.json).toEqual({ error: 'Too many people are waiting to be let in. Try again in a few minutes.' });
      expect((await guest.get('status')).json).toEqual({ state: 'new' });
    });

    it.each([
      ['no Origin', { origin: undefined }],
      ['another site’s Origin', { origin: 'https://evil.example' }],
      ['an Origin that only starts like the tunnel’s', { origin: 'SITE.evil.example' }],
      ['another local port as Origin', { origin: 'http://127.0.0.1:1' }],
      ['a null Origin', { origin: 'null' }],
      ['a form’s content type', { 'content-type': 'application/x-www-form-urlencoded' }],
      ['text/plain', { 'content-type': 'text/plain' }],
      ['no content type', { 'content-type': undefined }],
    ])('refuses a request with %s, and no request is created', async (_name, headers) => {
      const guest = await join();
      const sent = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, value?.replace('SITE', main.origin)]),
      );
      const res = await guest.post('ask', { name: 'Ana' }, sent);
      expect(res.status).toBe(403);
      expectJson(res);
      expect((await guest.get('status')).json).toEqual({ state: 'new' });
      expect(shares.get('r1')!.guests).toEqual([]);
    });

    it.each([
      ['a body that is not JSON', '{name', 400],
      ['no body', '', 400],
      ['a name that is not text', '{"name":42}', 400],
      ['a list', '["Ana"]', 400],
      ['a body over 1 KiB', `${JSON.stringify({ name: 'Ana' })}${' '.repeat(ASK_MAX)}`.slice(0, ASK_MAX + 1), 413],
    ])('answers %s without creating a request', async (_name, body, status) => {
      const guest = await join();
      const res = await guest.post('ask', body);
      expect(res.status).toBe(status);
      expectJson(res);
      expect(shares.get('r1')!.guests).toEqual([]);
    });
  });

  describe('the body of POST ask', () => {
    it('is read up to exactly 1 KiB', async () => {
      const guest = await join();
      const res = await guest.post('ask', `${JSON.stringify({ name: 'Ana' })}${' '.repeat(ASK_MAX)}`.slice(0, ASK_MAX));
      expect(res.status).toBe(200);
    });

    it('that announces more than 1 KiB is refused unread, and the socket is closed', async () => {
      const guest = await join();
      const res = await unfinished(main, [
        `POST ${SHARE}/ask HTTP/1.1`,
        `Host: ${main.host}`,
        `Cookie: __cezar_share=${guest.cookie}`,
        `Origin: ${main.origin}`,
        'Content-Type: application/json',
        `Content-Length: ${ASK_MAX + 1}`,
      ]);
      expect(res.status).toBe(413);
      expect(shares.get('r1')!.guests).toEqual([]);
    });
  });

  describe('the shell', () => {
    const POLICY = /^default-src 'none'; script-src 'nonce-([A-Za-z0-9+/=]{22,})'; style-src 'nonce-\1'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/;

    it('gives an allowed guest the page built for their name, the asset’s title and their own frame address', async () => {
      const res = await shellOf(await guestIn('allowed', 'Ana'));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expectUncacheable(res);
      const nonce = POLICY.exec(String(res.headers['content-security-policy']))?.[1];
      expect(nonce).toBeDefined();
      expect(shells).toEqual([{ name: 'Ana', title: TITLE, nonce, frameSrc: expect.stringMatching(/^\/__cezar_share__\/a\/[a-f0-9]{64}\/settings-mockup\.html$/) }]);
      expect(res.body).toBe(`<!-- shell ${JSON.stringify(shells[0])} -->`);
    });

    it('mints a nonce for every load, and a frame address per guest that stays theirs', async () => {
      const ana = await guestIn('allowed', 'Ana');
      const piotr = await guestIn('allowed', 'Piotr');
      await shellOf(ana);
      await shellOf(ana);
      await shellOf(piotr);
      expect(shells[0]!.nonce).not.toBe(shells[1]!.nonce);
      expect(shells[0]!.frameSrc).toBe(shells[1]!.frameSrc);
      expect(shells[2]!.frameSrc).not.toBe(shells[0]!.frameSrc);
    });

    it.each(NOT_ALLOWED)('is not built for a %s browser', async (state) => {
      const res = await shellOf(await guestIn(state));
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${SHARE}/wait`);
      expect(shells).toEqual([]);
    });

    it('stops answering a guest the owner removed', async () => {
      const guest = await guestIn('allowed');
      expect(shares.removeGuest('r1', guest.id)).toBe(true);
      expect((await shellOf(guest)).status).toBe(302);
      expect(shells).toEqual([]);
    });
  });

  describe('asset files', () => {
    const PAGE = '<!doctype html><html><head><title>Settings mockup</title></head><body><img src="shots/a.png"><button>Save</button></body></html>';
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
    let assets: string;

    beforeEach(() => {
      assets = artifactsDir(dir, 'r1');
      mkdirSync(joinPath(assets, 'shots'), { recursive: true });
      writeFileSync(joinPath(assets, ASSET), PAGE);
      writeFileSync(joinPath(assets, 'shots', 'a.png'), PNG);
      writeFileSync(joinPath(assets, 'logo.png'), PNG);
      writeFileSync(joinPath(assets, 'other.html'), '<!doctype html><title>Other</title>secret page');
      writeFileSync(joinPath(assets, 'notes.md'), '# secret notes');
      writeFileSync(joinPath(assets, 'data.json'), '{"secret":true}');
      writeFileSync(joinPath(assets, 'archive.zip'), 'secret bytes');
      writeFileSync(joinPath(assets, '.env'), 'SECRET=1');
    });

    /** The frame's base for this guest: what the shell was handed. */
    async function viewOf(guest: Browser): Promise<string> {
      expect((await shellOf(guest)).status).toBe(200);
      return shells.at(-1)!.frameSrc.slice(0, -ASSET.length);
    }
    const file = (view: string, name: string, site: Site = main): Promise<Answer> => send(site.port, site.host, `${view}${name}`);

    it('serves the shared asset in the cockpit’s sandbox minus popups, with the framed picker appended', async () => {
      const view = await viewOf(await guestIn('allowed'));
      const res = await file(view, ASSET);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expectUncacheable(res);
      const base = `${main.origin}${view}`;
      const policy = String(res.headers['content-security-policy']);
      // C15: scripts and nothing else. Every other directive is the cockpit's own, byte for byte.
      expect(policy.startsWith("sandbox allow-scripts; default-src 'none';")).toBe(true);
      expect(policy).toBe(artifactCsp(true, base, 'allow-scripts'));
      expect(policy.replace('sandbox allow-scripts;', 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;')).toBe(artifactCsp(true, base));
      expect(policy).toContain(`img-src data: blob: ${base};`);
      expect(policy).toContain("connect-src 'none'");
      expect(policy).toContain("form-action 'none'");
      expect(policy).not.toContain('allow-same-origin');
      expect(policy).not.toContain('allow-popups');
      // The page first, untouched: a script before the doctype would drop it into quirks mode.
      expect(res.body.startsWith(PAGE)).toBe(true);
      const tail = res.body.slice(PAGE.length);
      expect(tail.startsWith('\n<script>')).toBe(true);
      expect(tail.endsWith('</script>\n')).toBe(true);
      // The shell is the picker's only parent, under either scheme a TLS edge may show.
      expect(tail).toContain(`"parentOrigins":["http://${main.host}","https://${main.host}"]`);
    });

    it('serves an image of the run, at the top or one folder down, with the inert policy', async () => {
      const view = await viewOf(await guestIn('allowed'));
      for (const name of ['shots/a.png', 'logo.png']) {
        const res = await file(view, name);
        expect(res.status, name).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expectUncacheable(res);
        expect(Buffer.from(res.body, 'utf8').length).toBeGreaterThan(0);
      }
    });

    it.each([
      ['another HTML asset of the task', 'other.html'],
      ['a Markdown asset', 'notes.md'],
      ['a JSON asset', 'data.json'],
      ['a file of no listed kind', 'archive.zip'],
      ['an image that is not there', 'shots/missing.png'],
      ['a folder', 'shots'],
    ])('answers 404 for %s, with nothing of it', async (_label, name) => {
      const view = await viewOf(await guestIn('allowed'));
      const res = await file(view, name);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain('secret');
      expectUncacheable(res);
    });

    it('never follows a symlink out of the folder, for the shared name or an image', async () => {
      const outside = joinPath(dir, 'outside.html');
      writeFileSync(outside, 'secret outside');
      rmSync(joinPath(assets, ASSET));
      symlinkSync(outside, joinPath(assets, ASSET));
      symlinkSync(outside, joinPath(assets, 'link.png'));
      const view = await viewOf(await guestIn('allowed'));
      for (const name of [ASSET, 'link.png']) {
        const res = await file(view, name);
        expect(res.status, name).toBe(404);
        expect(res.body).not.toContain('secret');
      }
    });

    it('serves the file as it is now: a rewrite shows on the next load', async () => {
      const view = await viewOf(await guestIn('allowed'));
      expect((await file(view, ASSET)).body).toContain('<button>Save</button>');
      writeFileSync(joinPath(assets, ASSET), '<!doctype html><title>v2</title><button>Save changes</button>');
      const next = await file(view, ASSET);
      expect(next.body).toContain('<button>Save changes</button>');
      expect(next.body).not.toContain('<button>Save</button>');
    });

    it('answers a plain page while the shared file is gone, keeps the share up, and serves it again when it is back', async () => {
      const guest = await guestIn('allowed');
      const view = await viewOf(guest);
      rmSync(joinPath(assets, ASSET));
      const away = await file(view, ASSET);
      expect(away.status).toBe(404);
      expect(away.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(away.body).toBe('This page is not available right now.');
      expectUncacheable(away);
      expect(shares.get('r1')).not.toBeNull();
      expect((await guest.get('status')).json.state).toBe('allowed');
      // Renamed to something that is no page: still away, not served as another kind.
      writeFileSync(joinPath(assets, 'settings-mockup.md'), '# moved');
      expect((await file(view, ASSET)).status).toBe(404);
      writeFileSync(joinPath(assets, ASSET), PAGE);
      expect((await file(view, ASSET)).status).toBe(200);
    });

    it('drops every https source when CEZ_ARTIFACTS_CDN is off, as the cockpit does', async () => {
      cdn = false;
      const view = await viewOf(await guestIn('allowed'));
      const policy = String((await file(view, ASSET)).headers['content-security-policy']);
      expect(policy).toBe(artifactCsp(false, `${main.origin}${view}`, 'allow-scripts'));
      expect(policy).not.toContain('https:');
    });

    it('reads a guest’s files from the share’s own task only', async () => {
      const elsewhere = await open('r2', 'p1');
      mkdirSync(artifactsDir(dir, 'r2'), { recursive: true });
      writeFileSync(joinPath(artifactsDir(dir, 'r2'), ASSET), '<!doctype html><title>r2</title>second task');
      const guest = await guestIn('allowed', 'Ola', elsewhere);
      const view = await viewOf(guest);
      expect((await file(view, ASSET, elsewhere)).body).toContain('second task');
      // The first task's image is not this share's.
      expect((await file(view, 'logo.png', elsewhere)).status).toBe(404);
      // And a key is good on its own share only.
      expect((await file(view, ASSET)).status).toBe(404);
    });

    it('answers 404 when the share’s project has no data folder', async () => {
      const lost = await open('r9', 'p-gone');
      const guest = await guestIn('allowed', 'Ana', lost);
      const view = await viewOf(guest);
      expect((await file(view, ASSET, lost)).status).toBe(404);
    });
  });

  describe('comments', () => {
    let ana: Browser;
    let piotr: Browser;

    beforeEach(async () => {
      ana = await guestIn('allowed', 'Ana');
      piotr = await guestIn('allowed', 'Piotr');
    });

    describe('saving one', () => {
      it('stores it on the run and answers 201 with the public shape', async () => {
        const res = await ana.post('comments', comment());
        expect(res.status).toBe(201);
        expectJson(res);
        expectUncacheable(res);
        expect(res.json).toEqual({
          comment: { ...comment(), asset: ASSET, id: expect.any(String), revision: 1, author: 'Ana', createdAt: new Date(clock).toISOString() },
        });
        expect(stored()).toEqual([{ ...res.json.comment, guestId: ana.id }]);
        expect(published).toEqual([['p1', 'r1']]);
      });

      it('takes the author from the allowed guest, never from the body', async () => {
        await ana.post('comments', { ...comment(), author: 'Marta' });
        expect(stored()[0]!.author).toBe('Ana');
      });

      it('takes the guest, the id, the revision and the date from the server, never from the body', async () => {
        const res = await ana.post('comments', {
          ...comment(),
          guestId: piotr.id,
          id: 'chosen',
          revision: 9,
          createdAt: '2001-01-01T00:00:00.000Z',
          extra: 'x',
        });
        expect(res.status).toBe(201);
        expect(stored()).toEqual([
          { ...comment(), asset: ASSET, id: res.json.comment.id, revision: 1, author: 'Ana', guestId: ana.id, createdAt: new Date(clock).toISOString() },
        ]);
        expect(res.json.comment.id).not.toBe('chosen');
        expect((await piotr.get('comments')).json.comments).toEqual([]);
      });

      // What the owner reads must be in the order the agent receives: a right-to-left override
      // shows `run it` where the bytes say something else.
      const BIDI = ['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069'];
      const laced = (text: string): string => BIDI.map((mark) => `${mark}${text}`).join('') + BIDI.join('');
      const hasBidi = (value: unknown): boolean => BIDI.some((mark) => JSON.stringify(value).includes(mark));

      it('stores every text field without bidi controls', async () => {
        const res = await ana.post('comments', {
          selector: laced('a'),
          label: laced('b'),
          excerpt: laced('c'),
          component: laced('d'),
          body: `Looks fine\u202e gnihtyreve eteled`,
        });
        expect(res.status).toBe(201);
        expect(hasBidi(res.json)).toBe(false);
        expect(hasBidi(stored())).toBe(false);
        expect(stored()[0]).toMatchObject({
          selector: 'a'.repeat(12),
          label: 'b'.repeat(12),
          excerpt: 'c'.repeat(12),
          component: 'd'.repeat(12),
          body: 'Looks fine gnihtyreve eteled',
        });
        // Joiners are part of the text, not of its direction: an emoji and a Persian word stay whole.
        const joined = await ana.post('comments', { ...comment(), body: '\u{1F469}\u200d\u{1F4BB} می\u200cخواهم' });
        expect(stored()[1]!.body).toBe('\u{1F469}\u200d\u{1F4BB} می\u200cخواهم');
        expect(joined.status).toBe(201);
      });

      it('answers 400 to a comment, or a selector, made only of bidi controls', async () => {
        for (const fields of [{ body: BIDI.join('') }, { body: ` ${BIDI.join(' ')} ` }, { selector: BIDI.join('') }]) {
          const res = await ana.post('comments', { ...comment(), ...fields });
          expect(res.status).toBe(400);
          expect(res.json).toEqual({ error: 'That comment cannot be saved as it is.' });
        }
        expect(stored()).toEqual([]);
        expect(published).toEqual([]);
      });

      it('strips bidi controls from an edit too, and refuses one made only of them', async () => {
        const first = (await ana.post('comments', comment())).json.comment;
        const res = await ana.put(`comments/${first.id}`, { body: laced('x') });
        expect(res.status).toBe(200);
        expect(stored()[0]).toMatchObject({ body: 'x'.repeat(12), revision: 2 });
        expect((await ana.put(`comments/${first.id}`, { body: BIDI.join('') })).status).toBe(400);
        expect(stored()[0]).toMatchObject({ body: 'x'.repeat(12), revision: 2 });
      });

      it('trims the body and keeps the optional component', async () => {
        const res = await ana.post('comments', { ...comment(), body: '  green, please \n', component: 'SettingsPage › Button (src/ui/button.tsx:14)' });
        expect(res.status).toBe(201);
        expect(stored()[0]).toMatchObject({ body: 'green, please', component: 'SettingsPage › Button (src/ui/button.tsx:14)' });
      });

      it('accepts a content type that names its charset', async () => {
        expect((await ana.post('comments', comment(), { 'content-type': 'Application/JSON; charset=utf-8' })).status).toBe(201);
      });

      it('takes the asset from the share, never from the body, and keeps no address', async () => {
        const res = await ana.post('comments', { ...comment(), asset: 'other.html', url: 'https://evil.example/' });
        expect(res.status).toBe(201);
        expect(res.json.comment.asset).toBe(ASSET);
        expect(stored()[0]!.asset).toBe(ASSET);
        expect(stored()[0]).not.toHaveProperty('url');
      });

      it.each([
        ['no selector', () => ({ ...comment(), selector: undefined })],
        ['an empty selector', () => ({ ...comment(), selector: '' })],
        ['no text', () => ({ ...comment(), body: '  \n ' })],
        ['text over 2,000 characters', () => ({ ...comment(), body: 'x'.repeat(2001) })],
        ['markup over 600 characters', () => ({ ...comment(), excerpt: 'x'.repeat(601) })],
        ['a label over 80 characters', () => ({ ...comment(), label: 'x'.repeat(81) })],
        ['a field that is not text', () => ({ ...comment(), label: 7 })],
        ['a list', () => [comment()]],
        ['a bare word', () => 'null'],
        ['a body that is not JSON', () => '{"body":'],
        ['no body', () => ''],
      ])('answers 400 to %s', async (_name, body) => {
        const res = await ana.post('comments', body());
        expect(res.status).toBe(400);
        expectJson(res);
        expect(stored()).toEqual([]);
        expect(published).toEqual([]);
      });

      it('answers 409 once the run holds 50 unsent comments', async () => {
        for (let i = 0; i < GUEST_COMMENTS_MAX; i += 1) addGuestComment(dir, 'r1', { ...comment(), asset: ASSET, body: `c${i}`, author: 'Piotr', guestId: piotr.id });
        const res = await ana.post('comments', comment());
        expect(res.status).toBe(409);
        expectJson(res);
        expect(res.json).toEqual({ error: INBOX_FULL });
        expect(stored()).toHaveLength(GUEST_COMMENTS_MAX);
        expect(published).toEqual([]);
      });

      it('answers 409 once the run’s unsent text would pass its budget', async () => {
        const big = { ...comment(), excerpt: 'e'.repeat(600), selector: 's'.repeat(1000), body: 'b'.repeat(2000) };
        const each = ASSET.length + big.selector.length + big.label.length + big.excerpt.length + big.body.length + GUEST_COMMENT_OVERHEAD;
        for (let i = 0; i < Math.floor(GUEST_COMMENTS_TEXT_BUDGET / each); i += 1) {
          expect(addGuestComment(dir, 'r1', { ...big, asset: ASSET, author: 'Piotr', guestId: piotr.id }).ok).toBe(true);
        }
        const before = stored().length;
        const res = await ana.post('comments', big);
        expect(res.status).toBe(409);
        expect(res.json).toEqual({ error: INBOX_FULL });
        expect(stored()).toHaveLength(before);
      });

      it('answers 500 when the comment could not be written, and announces nothing', async () => {
        writeFileSync(guestCommentsRoot(dir), 'a file where the folder goes');
        const res = await ana.post('comments', comment());
        expect(res.status).toBe(500);
        expectJson(res);
        expect(res.json).toEqual({ error: 'The comment could not be saved.' });
        expect(published).toEqual([]);
      });

      it('still answers the guest when announcing a write throws', async () => {
        onComments = () => {
          throw new Error('no listeners');
        };
        const res = await ana.post('comments', comment());
        expect(res.status).toBe(201);
        expect((await ana.put(`comments/${res.json.comment.id}`, { body: 'again' })).status).toBe(200);
        expect((await ana.delete(`comments/${res.json.comment.id}`)).status).toBe(204);
        expect(stored()).toEqual([]);
      });
    });

    describe('listing', () => {
      it('gives a guest their own comments only, without the guest id', async () => {
        const mine = (await ana.post('comments', comment())).json.comment;
        await piotr.post('comments', { ...comment(), body: 'Piotr’s private note' });
        const res = await ana.get('comments');
        expect(res.status).toBe(200);
        expectJson(res);
        expectUncacheable(res);
        expect(res.json).toEqual({ comments: [mine] });
        expect(res.body).not.toContain('Piotr');
        expect(res.body).not.toContain('guestId');
        expect(res.body).not.toContain(ana.id);
        expect(res.body).not.toContain(piotr.id);
      });

      it('answers an empty list before anything was saved', async () => {
        expect((await ana.get('comments')).json).toEqual({ comments: [] });
      });
    });

    describe('editing', () => {
      it('replaces the text of the guest’s own comment and moves its revision on', async () => {
        const first = (await ana.post('comments', comment())).json.comment;
        const res = await ana.put(`comments/${first.id}`, { body: '  Teal instead. ' });
        expect(res.status).toBe(200);
        expectJson(res);
        expect(res.json).toEqual({ comment: { ...first, body: 'Teal instead.', revision: 2 } });
        expect(stored()).toEqual([{ ...first, body: 'Teal instead.', revision: 2, guestId: ana.id }]);
        expect(published).toEqual([
          ['p1', 'r1'],
          ['p1', 'r1'],
        ]);
      });

      it('changes the text only, whatever else the body carries', async () => {
        const first = (await ana.post('comments', comment())).json.comment;
        const res = await ana.put(`comments/${first.id}`, {
          body: 'new text',
          author: 'Marta',
          guestId: piotr.id,
          asset: 'other.html',
          selector: 'body',
          revision: 40,
          id: 'other',
        });
        expect(res.status).toBe(200);
        expect(stored()).toEqual([{ ...first, body: 'new text', revision: 2, guestId: ana.id }]);
      });

      it.each([
        ['no text', { body: ' ' }],
        ['text over 2,000 characters', { body: 'x'.repeat(2001) }],
        ['text that is not text', { body: 5 }],
        ['no body field', { text: 'x' }],
        ['a body that is not JSON', '{'],
      ])('answers 400 to %s and leaves the comment alone', async (_name, body) => {
        const first = (await ana.post('comments', comment())).json.comment;
        const res = await ana.put(`comments/${first.id}`, body);
        expect(res.status).toBe(400);
        expectJson(res);
        expect(stored()[0]).toMatchObject({ body: comment().body, revision: 1 });
        expect(published).toHaveLength(1);
      });

      it('answers 409 when the longer text would pass the run’s budget', async () => {
        const first = (await ana.post('comments', comment())).json.comment;
        const big = { ...comment(), excerpt: 'e'.repeat(600), selector: 's'.repeat(1000), body: 'b'.repeat(2000) };
        // Big ones, then small ones: what is left is less than one small comment, whatever the cost rule.
        for (const filler of [big, comment()]) {
          while (addGuestComment(dir, 'r1', { ...filler, asset: ASSET, author: 'Piotr', guestId: piotr.id }).ok) {
            /* fill what is left */
          }
        }
        expect(stored().length).toBeLessThan(GUEST_COMMENTS_MAX);
        const res = await ana.put(`comments/${first.id}`, { body: 'x'.repeat(2000) });
        expect(res.status).toBe(409);
        expect(res.json).toEqual({ error: INBOX_FULL });
        expect(stored()[0]).toMatchObject({ body: comment().body, revision: 1 });
      });

      it('answers 404 for a comment that does not exist', async () => {
        const res = await ana.put('comments/00000000-0000-4000-8000-000000000000', { body: 'x' });
        expect(res.status).toBe(404);
        expectJson(res);
        expect(res.json).toEqual({ error: 'That comment is no longer there.' });
        expect((await ana.delete('comments/00000000-0000-4000-8000-000000000000')).json).toEqual(res.json);
        expect(published).toEqual([]);
      });
    });

    describe('deleting', () => {
      it('removes the guest’s own comment and answers 204 with no body', async () => {
        const { id } = (await ana.post('comments', comment())).json.comment;
        const res = await ana.delete(`comments/${id}`);
        expect(res.status).toBe(204);
        expect(res.body).toBe('');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(stored()).toEqual([]);
        expect(published).toHaveLength(2);
        expect((await ana.delete(`comments/${id}`)).status).toBe(404);
        expect(published).toHaveLength(2);
      });
    });

    describe('another guest’s comment', () => {
      it("answers 404 when a guest edits or deletes another guest's comment, and changes nothing", async () => {
        const id = (await ana.post('comments', comment())).json.comment.id;
        expect((await piotr.put(`comments/${id}`, { body: 'x' })).status).toBe(404);
        expect((await piotr.delete(`comments/${id}`)).status).toBe(404);
        expect(readGuestComments(dir, 'r1')[0]!.body).toBe(comment().body);
        expect(stored()[0]).toMatchObject({ revision: 1, author: 'Ana', guestId: ana.id });
        expect(published).toHaveLength(1);
      });

      it('answers exactly as it does for a comment that never existed', async () => {
        const id = (await ana.post('comments', comment())).json.comment.id;
        const missing = '00000000-0000-4000-8000-000000000000';
        const theirsPut = await piotr.put(`comments/${id}`, { body: 'x' });
        const missingPut = await piotr.put(`comments/${missing}`, { body: 'x' });
        expect([theirsPut.status, theirsPut.body]).toEqual([missingPut.status, missingPut.body]);
        const theirsDelete = await piotr.delete(`comments/${id}`);
        const missingDelete = await piotr.delete(`comments/${missing}`);
        expect([theirsDelete.status, theirsDelete.body]).toEqual([missingDelete.status, missingDelete.body]);
      });

      it('is out of reach of a guest on another task’s share, even with its id', async () => {
        const other = await open('r2', 'p1');
        const stranger = await guestIn('allowed', 'Ana', other);
        const id = (await ana.post('comments', comment())).json.comment.id;
        expect((await stranger.get('comments')).json).toEqual({ comments: [] });
        expect((await stranger.put(`comments/${id}`, { body: 'x' })).status).toBe(404);
        expect((await stranger.delete(`comments/${id}`)).status).toBe(404);
        expect(stored()).toHaveLength(1);
        // A cookie belongs to one share: on the other listener it is no cookie at all.
        const crossed = await browser(stranger.cookie, main).get('comments');
        expect(crossed.status).toBe(404);
        expect(crossed.body).toBe(GONE);
      });
    });

    describe('a comment address', () => {
      it.each([
        ['an extra segment', (id: string) => `comments/${id}/x`],
        ['a trailing slash', (id: string) => `comments/${id}/`],
        ['an encoded character', (id: string) => `comments/%${id.charCodeAt(0).toString(16)}${id.slice(1)}`],
        ['a doubled slash', (id: string) => `comments//${id}`],
        ['a matrix parameter', (id: string) => `comments/${id};x=1`],
      ])('with %s matches nothing', async (_name, path) => {
        const { id } = (await ana.post('comments', comment())).json.comment;
        expectGone(await ana.put(path(id), { body: 'x' }));
        expectGone(await ana.delete(path(id)));
        expect(stored()[0]).toMatchObject({ body: comment().body, revision: 1 });
      });

      it.each([['comments/..'], ['comments/%2e%2e'], ['comments/a.b'], [`comments/${'a'.repeat(65)}`], ['comments/'], ['comments/a b']])(
        'refuses %s as an id',
        async (path) => {
          expectGone(await ana.put(path.replace(' ', '%20'), { body: 'x' }));
          expectGone(await ana.delete(path.replace(' ', '%20')));
        },
      );
    });

    describe('a browser that is not let in', () => {
      it.each(NOT_ALLOWED)('answers 404 to every comment request from a %s browser, and stores nothing', async (state) => {
        const { id } = (await ana.post('comments', comment())).json.comment;
        const guest = await guestIn(state, 'Ewa');
        for (const res of [
          await guest.get('comments'),
          await guest.post('comments', comment()),
          await guest.put(`comments/${id}`, { body: 'x' }),
          await guest.delete(`comments/${id}`),
        ]) {
          expectGone(res);
          expect(res.body).not.toContain(comment().body);
        }
        expect(stored()).toHaveLength(1);
        expect(stored()[0]).toMatchObject({ body: comment().body, revision: 1 });
        expect(published).toHaveLength(1);
      });

      it('shuts a removed guest out of the comments they left, which stay for the owner', async () => {
        const { id } = (await ana.post('comments', comment())).json.comment;
        expect(shares.removeGuest('r1', ana.id)).toBe(true);
        expectGone(await ana.get('comments'));
        expectGone(await ana.post('comments', comment()));
        expectGone(await ana.put(`comments/${id}`, { body: 'x' }));
        expectGone(await ana.delete(`comments/${id}`));
        expect(stored()).toHaveLength(1);
        expect(stored()[0]).toMatchObject({ id, body: comment().body, revision: 1 });
      });

      it('answers a browser with no cookie, or one this share never issued, nothing of the routes', async () => {
        const unknown = browser('f'.repeat(64));
        for (const res of [
          await unknown.get('comments'),
          await unknown.get('status'),
          await unknown.get('wait'),
          await unknown.post('comments', comment()),
          await send(main.port, main.host, `${SHARE}/comments`),
        ]) {
          expect(res.status).toBe(404);
          expect(res.body).toBe(GONE);
        }
        expect(stored()).toEqual([]);
        expect(shells).toEqual([]);
      });
    });

    describe('a forged write', () => {
      it.each([
        ['no Origin', { origin: undefined }],
        ['another site’s Origin', { origin: 'https://evil.example' }],
        ['an Origin that only starts like the tunnel’s', { origin: 'SITE.evil.example' }],
        ['the tunnel’s Origin with a path', { origin: 'SITE/' }],
        ['another local port as Origin', { origin: 'http://127.0.0.1:1' }],
        ['a null Origin', { origin: 'null' }],
        ['a form’s content type', { 'content-type': 'application/x-www-form-urlencoded' }],
        ['text/plain', { 'content-type': 'text/plain' }],
        ['a type that only starts like JSON', { 'content-type': 'application/jsonp' }],
        ['no content type', { 'content-type': undefined }],
      ])('with %s is refused on every write, and changes nothing', async (_name, headers) => {
        const { id } = (await ana.post('comments', comment())).json.comment;
        const sent = Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [name, value?.replace('SITE', main.origin)]),
        );
        for (const res of [
          await ana.post('comments', comment(), sent),
          await ana.put(`comments/${id}`, { body: 'x' }, sent),
          await ana.delete(`comments/${id}`, sent),
        ]) {
          expect(res.status).toBe(403);
          expectJson(res);
        }
        expect(stored()).toHaveLength(1);
        expect(stored()[0]).toMatchObject({ body: comment().body, revision: 1 });
        expect(published).toHaveLength(1);
      });

      it('refuses a write without the tunnel Origin', async () => {
        expect((await ana.post('comments', comment(), { origin: undefined })).status).toBe(403);
        expect(stored()).toEqual([]);
      });
    });

    describe('a body', () => {
      const head = (guest: Browser, extra: string[]): string[] => [
        `POST ${SHARE}/comments HTTP/1.1`,
        `Host: ${guest.site.host}`,
        `Cookie: __cezar_share=${guest.cookie}`,
        `Origin: ${guest.site.origin}`,
        'Content-Type: application/json',
        ...extra,
      ];

      it('of exactly 64 KiB is read', async () => {
        const text = JSON.stringify(comment());
        const res = await ana.post('comments', text + ' '.repeat(BODY_MAX - text.length));
        expect(res.status).toBe(201);
      });

      it('over 64 KiB answers 413 and stores nothing', async () => {
        const text = JSON.stringify(comment());
        const res = await ana.post('comments', text + ' '.repeat(BODY_MAX + 1 - text.length));
        expect(res.status).toBe(413);
        expectJson(res);
        expect(stored()).toEqual([]);
        expect(published).toEqual([]);
      });

      it('that announces more than 64 KiB is refused before a byte of it is read, and the socket is closed', async () => {
        const res = await unfinished(main, head(ana, [`Content-Length: ${BODY_MAX + 1}`]));
        expect(res.status).toBe(413);
        expect(stored()).toEqual([]);
      });

      it('that never ends is cut off at 64 KiB: the socket is closed, not left reading', async () => {
        const size = BODY_MAX + 1;
        const res = await unfinished(main, head(ana, ['Transfer-Encoding: chunked']), `${size.toString(16)}\r\n${'a'.repeat(size)}`);
        expect(res.status).toBe(413);
        expect(stored()).toEqual([]);
      });
    });

    describe('a write still on its way', () => {
      const head = (guest: Browser, length: number): string[] => [
        `POST ${SHARE}/comments HTTP/1.1`,
        `Host: ${guest.site.host}`,
        `Cookie: __cezar_share=${guest.cookie}`,
        `Origin: ${guest.site.origin}`,
        'Content-Type: application/json',
        `Content-Length: ${length}`,
      ];
      const arrived = (): number => handed.filter((line) => line === `POST ${SHARE}/comments`).length;

      it('is cut when the owner removes the guest: finishing the body saves nothing and announces nothing', async () => {
        const text = JSON.stringify(comment());
        const pending = stalled(main, head(ana, text.length), text.slice(0, 20));
        await until(() => arrived() === 1);
        expect(shares.removeGuest('r1', ana.id)).toBe(true);
        pending.socket.write(text.slice(20));
        expect((await pending.settled).answered).toBe(false);
        expect(stored()).toEqual([]);
        expect(published).toEqual([]);
        // Another guest's requests are not touched.
        expect((await piotr.post('comments', comment())).status).toBe(201);
      });

      it('that the browser abandons mid-body saves nothing, answers nothing and breaks nothing', async () => {
        // A whole comment, but less than was announced: only the end of the body may save it.
        const text = JSON.stringify(comment());
        const pending = stalled(main, head(ana, text.length + 10), text);
        await until(() => arrived() === 1);
        pending.socket.destroy();
        expect(await pending.settled).toEqual({ answered: false, text: '' });
        expect((await ana.post('comments', { ...comment(), body: 'the next one' })).status).toBe(201);
        expect(stored().map((saved) => saved.body)).toEqual(['the next one']);
        expect(published).toHaveLength(1);
      });

      it('that stalls is answered 408 after the deadline, and the socket is closed', async () => {
        const quick = buildShares(buildRoutes(40));
        const site = await open('r5', 'p1', quick);
        const guest = await guestIn('allowed', 'Ana', site, quick);
        const text = JSON.stringify(comment());
        const res = await unfinished(site, head(guest, text.length), text.slice(0, 20));
        expect(res.status).toBe(408);
        expect(stored('r5')).toEqual([]);
        expect(published).toEqual([]);

        const asking = await join(site);
        const ask = await unfinished(
          site,
          [`POST ${SHARE}/ask HTTP/1.1`, `Host: ${site.host}`, `Cookie: __cezar_share=${asking.cookie}`, `Origin: ${site.origin}`, 'Content-Type: application/json', 'Content-Length: 14'],
          '{"name":',
        );
        expect(ask.status).toBe(408);
        expect((await asking.get('status')).json).toEqual({ state: 'new' });
      });

      it('that arrives in time is not touched by the deadline', async () => {
        const quick = buildShares(buildRoutes(40));
        const site = await open('r5', 'p1', quick);
        const guest = await guestIn('allowed', 'Ana', site, quick);
        expect((await guest.post('comments', comment())).status).toBe(201);
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(stored('r5')).toHaveLength(1);
        expect((await guest.get('comments')).status).toBe(200);
      });
    });

    describe('the write limit', () => {
      it('answers 429 to the 31st write in a minute from one guest, and to nobody else', async () => {
        for (let i = 0; i < 30; i += 1) expect((await ana.post('comments', { ...comment(), body: `c${i}` })).status).toBe(201);
        const res = await ana.post('comments', comment());
        expect(res.status).toBe(429);
        expectJson(res);
        expect(res.headers['retry-after']).toBe('60');
        expect(stored()).toHaveLength(30);
        expect((await ana.get('comments')).json.comments).toHaveLength(30);
        expect((await piotr.post('comments', comment())).status).toBe(201);
      });

      it('counts edits, deletes and refused writes alike', async () => {
        const { id } = (await ana.post('comments', comment())).json.comment;
        for (let i = 0; i < 10; i += 1) expect((await ana.put(`comments/${id}`, { body: `edit ${i}` })).status).toBe(200);
        for (let i = 0; i < 10; i += 1) expect((await ana.delete('comments/missing')).status).toBe(404);
        for (let i = 0; i < 9; i += 1) expect((await ana.post('comments', { nonsense: true })).status).toBe(400);
        expect((await ana.put(`comments/${id}`, { body: 'one too many' })).status).toBe(429);
        expect((await ana.delete(`comments/${id}`)).status).toBe(429);
        expect(stored()[0]).toMatchObject({ body: 'edit 9', revision: 11 });
      });

      it('lets the guest write again once the minute has passed', async () => {
        for (let i = 0; i < 30; i += 1) await ana.delete('comments/missing');
        expect((await ana.post('comments', comment())).status).toBe(429);
        clock += MINUTE - 1;
        expect((await ana.post('comments', comment())).status).toBe(429);
        clock += 1;
        expect((await ana.post('comments', comment())).status).toBe(201);
      });

      it('is not spent by a forged write or by a browser that is not let in', async () => {
        const waiting = await guestIn('waiting', 'Ewa');
        for (let i = 0; i < 40; i += 1) {
          expect((await ana.post('comments', comment(), { origin: 'https://evil.example' })).status).toBe(403);
          expect((await waiting.post('comments', comment())).status).toBe(404);
        }
        expect((await ana.post('comments', comment())).status).toBe(201);
        shares.decide('r1', waiting.id, 'allow');
        expect((await waiting.post('comments', comment())).status).toBe(201);
      });
    });

    it('answers 404 when the share’s project has no data folder', async () => {
      const guest = await guestIn('allowed', 'Ana', await open('r3', 'gone'));
      for (const res of [
        await guest.get('comments'),
        await guest.post('comments', comment()),
        await guest.put('comments/abc', { body: 'x' }),
        await guest.delete('comments/abc'),
      ]) {
        expectGone(res);
      }
      expect(published).toEqual([]);
    });
  });

  describe('a path that matches nothing', () => {
    it.each([
      ['GET', ''],
      ['GET', 'nope'],
      ['GET', 'wait/'],
      ['GET', 'WAIT'],
      ['GET', 'status/x'],
      ['GET', 'guest.js.map'],
      ['GET', 'guest%2Ejs'],
      ['GET', 'comments/abc'],
      ['GET', 'ask'],
      ['GET', '../settings'],
      ['POST', 'wait'],
      ['POST', 'status'],
      ['POST', 'guest.js'],
      ['POST', 'comments/abc'],
      ['PUT', 'comments'],
      ['PUT', 'ask'],
      ['DELETE', 'comments'],
      ['PATCH', 'comments/abc'],
    ])('%s %s answers 404', async (method, path) => {
      const guest = await guestIn('allowed');
      const res = await guest.call(method, path, method === 'GET' || method === 'DELETE' ? undefined : { body: 'x', name: 'x' });
      expectGone(res);
      expectUncacheable(res);
    });

    it('answers 404 for the bare prefix too', async () => {
      const guest = await guestIn('allowed');
      const res = await send(main.port, main.host, SHARE, { headers: { cookie: `__cezar_share=${guest.cookie}` } });
      expectGone(res);
    });
  });

  describe('called directly', () => {
    const ORIGIN = 'https://quiet-river.trycloudflare.com';

    /** One bodyless request handed straight to the routes, as the listener hands them over. */
    function direct(on: GuestRoutes, guest: GuestRequest['guest'], method: string, path: string): { returned: boolean; status: number; headers: Record<string, string> } {
      const seen = { status: 0, headers: {} as Record<string, string> };
      const res = {
        headersSent: false,
        destroyed: false,
        writeHead(status: number, headers: Record<string, string> = {}) {
          seen.status = status;
          seen.headers = headers;
          this.headersSent = true;
          return this;
        },
        setHeader(name: string, value: string) {
          seen.headers[name] = value;
        },
        end() {
          return this;
        },
        destroy() {},
      };
      const req = { method, url: path, headers: { origin: ORIGIN, 'content-type': 'application/json' }, on: () => req };
      const ctx: GuestRequest = { runId: 'r1', projectId: 'p1', path, tunnelOrigin: ORIGIN, asset: ASSET, assetTitle: TITLE, guest, ask: () => ({ error: 'no' }) };
      const returned = on.handle(ctx, req as unknown as IncomingMessage, res as unknown as ServerResponse);
      return { returned, ...seen };
    }

    it('always takes the request: true for every path, state and method, so nothing falls through', () => {
      for (const state of EVERY_STATE) {
        for (const method of ['GET', 'DELETE', 'HEAD', 'OPTIONS']) {
          for (const path of [SHARE, `${SHARE}/`, `${SHARE}/wait`, `${SHARE}/status`, `${SHARE}/guest.js`, `${SHARE}/comments`, `${SHARE}/comments/abc`, `${SHARE}/nope`, '/settings']) {
            const answer = direct(routes, { id: 'a'.repeat(16), state, name: 'Ana', code: '1234' }, method, path);
            expect(answer.returned).toBe(true);
            expect(answer.status).toBeGreaterThanOrEqual(200);
          }
        }
      }
      expect(direct(routes, null, 'GET', `${SHARE}/comments`)).toMatchObject({ returned: true, status: 404 });
    });

    it('leaves the listener’s cache headers alone on every answer', () => {
      for (const state of EVERY_STATE) {
        for (const path of ['wait', 'status', 'guest.js', 'comments', 'comments/abc', 'nope']) {
          for (const method of ['GET', 'DELETE']) {
            const names = Object.keys(direct(routes, { id: 'a'.repeat(16), state, name: 'Ana', code: '1234' }, method, `${SHARE}/${path}`).headers);
            expect(names.map((name) => name.toLowerCase())).not.toContain('cache-control');
            expect(names.map((name) => name.toLowerCase())).not.toContain('cdn-cache-control');
          }
        }
      }
    });

    it('answers 404 to an allowed guest that somehow has no name, rather than saving an unnamed comment', () => {
      expect(direct(routes, { id: 'a'.repeat(16), state: 'allowed' }, 'GET', `${SHARE}/comments`).status).toBe(404);
    });

    it('answers 500 when the shell cannot be built, and 404 to anyone who is not an allowed, named guest with a view', () => {
      const shell = (on: GuestRoutes, guest: GuestRequest['guest'], viewBase?: string): number => {
        const seen = { status: 0 };
        const res = {
          headersSent: false,
          destroyed: false,
          writeHead(status: number) {
            seen.status = status;
            this.headersSent = true;
            return this;
          },
          end() {
            return this;
          },
          destroy() {},
        };
        const ctx: GuestRequest = { runId: 'r1', projectId: 'p1', path: '/', tunnelOrigin: ORIGIN, asset: ASSET, assetTitle: TITLE, ...(viewBase ? { viewBase } : {}), guest, ask: () => ({ error: 'no' }) };
        on.shell(ctx, {} as IncomingMessage, res as unknown as ServerResponse);
        return seen.status;
      };
      const broken = createGuestRoutes({
        dataDirOf: () => dir,
        onComments: () => {},
        guestShell: () => {
          throw new Error('no shell');
        },
      });
      const view = `${SHARE}/a/${'a'.repeat(64)}/`;
      expect(shell(broken, { id: 'a'.repeat(16), state: 'allowed', name: 'Ana' }, view)).toBe(500);
      expect(shell(routes, { id: 'a'.repeat(16), state: 'allowed', name: 'Ana' }, view)).toBe(200);
      expect(shell(routes, { id: 'a'.repeat(16), state: 'allowed', name: 'Ana' })).toBe(404);
      expect(shell(routes, { id: 'a'.repeat(16), state: 'allowed' }, view)).toBe(404);
      expect(shell(routes, { id: 'a'.repeat(16), state: 'waiting', name: 'Ana' }, view)).toBe(404);
      expect(shell(routes, null, view)).toBe(404);
    });

    /** A `POST comments` whose body the test feeds by hand, and an answer that only counts what was written. */
    function fed() {
      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: `${SHARE}/comments`,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
      });
      const res = {
        headersSent: false,
        destroyed: false,
        answers: [] as number[],
        writeHead(status: number) {
          this.answers.push(status);
          this.headersSent = true;
          return this;
        },
        end() {
          return this;
        },
        destroy() {},
      };
      const ctx: GuestRequest = {
        runId: 'r1',
        projectId: 'p1',
        path: `${SHARE}/comments`,
        tunnelOrigin: ORIGIN,
        asset: ASSET,
        assetTitle: TITLE,
        guest: { id: 'a'.repeat(16), state: 'allowed', name: 'Ana', code: '1234' },
        ask: () => ({ error: 'no' }),
      };
      expect(routes.handle(ctx, req as unknown as IncomingMessage, res as unknown as ServerResponse)).toBe(true);
      const whole = Buffer.from(JSON.stringify(comment()));
      const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
      return { req, res, whole, turn };
    }

    it('saves a comment only when its body ended on a connection that is still there', async () => {
      const closed = fed();
      closed.req.emit('data', closed.whole);
      closed.req.emit('close');
      await closed.turn();
      expect(closed.res.answers).toEqual([]);

      const cut = fed();
      cut.req.emit('data', cut.whole);
      cut.res.destroyed = true;
      cut.req.emit('end');
      await cut.turn();
      expect(cut.res.answers).toEqual([]);

      expect(stored()).toEqual([]);
      expect(published).toEqual([]);

      const whole = fed();
      whole.req.emit('data', whole.whole);
      whole.req.emit('end');
      whole.req.emit('close');
      await whole.turn();
      expect(whole.res.answers).toEqual([201]);
      expect(stored()).toHaveLength(1);
      expect(published).toEqual([['p1', 'r1']]);
    });

    it('remembers at most 1,000 writing guests, and forgets them a minute after their last write', () => {
      const guest = (n: number): GuestRequest['guest'] => ({ id: n.toString(16).padStart(16, '0'), state: 'allowed', name: 'Ana', code: '1234' });
      for (let n = 0; n < 1000; n += 1) expect(direct(routes, guest(n), 'DELETE', `${SHARE}/comments/abc`).status).toBe(404);
      expect(direct(routes, guest(1000), 'DELETE', `${SHARE}/comments/abc`).status).toBe(429);
      // A guest already counted is still served.
      expect(direct(routes, guest(1), 'DELETE', `${SHARE}/comments/abc`).status).toBe(404);
      clock += MINUTE;
      expect(direct(routes, guest(1000), 'DELETE', `${SHARE}/comments/abc`).status).toBe(404);
      // Only guest 1000 is remembered now: 999 more fit.
      for (let n = 2000; n < 2999; n += 1) expect(direct(routes, guest(n), 'DELETE', `${SHARE}/comments/abc`).status).toBe(404);
      expect(direct(routes, guest(2999), 'DELETE', `${SHARE}/comments/abc`).status).toBe(429);
    });
  });
});
