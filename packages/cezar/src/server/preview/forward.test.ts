import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forwardRequest, stripCookies, stripSetCookieDomain, type ForwardOptions } from './forward.ts';

/**
 * The forwarding the Design Mode mirror and the share listener both use (spec
 * 2026-11-26-preview-share-link § Mechanism step 2). The mirror's own behaviour is pinned by
 * `design-proxy.test.ts`; this pins what the share listener adds on top.
 */

describe('stripCookies', () => {
  it('removes only the named cookies', () => {
    expect(stripCookies('a=1; __cezar_share=secret; b=2', ['__cezar_share'])).toBe('a=1; b=2');
    expect(stripCookies('__cezar_share=secret', ['__cezar_share'])).toBeUndefined();
  });

  it('keeps a cookie whose name only starts like a dropped one, and leaves an untouched header as it was', () => {
    expect(stripCookies('__cezar_share_x=1;a=2', ['__cezar_share'])).toBe('__cezar_share_x=1;a=2');
    expect(stripCookies(undefined, ['__cezar_share'])).toBeUndefined();
  });

  it('leaves no empty segment behind when the header ended in a separator', () => {
    expect(stripCookies('a=1; __cezar_share=x;', ['__cezar_share'])).toBe('a=1');
    expect(stripCookies('__cezar_share=x; ;a=1;;', ['__cezar_share'])).toBe('a=1');
  });
});

describe('stripSetCookieDomain', () => {
  it('drops Domain from Set-Cookie and keeps every other attribute', () => {
    expect(stripSetCookieDomain('sid=1; Domain=localhost; Path=/; HttpOnly')).toBe('sid=1; Path=/; HttpOnly');
  });

  it('matches Domain in any case, and every value of a repeated header', () => {
    expect(stripSetCookieDomain(['a=1; DOMAIN=.example.test', 'b=2; path=/; domain=localhost'])).toEqual(['a=1', 'b=2; path=/']);
  });

  it('never touches a cookie whose name or value merely contains "domain"', () => {
    expect(stripSetCookieDomain('domain=x; Path=/')).toBe('domain=x; Path=/');
    expect(stripSetCookieDomain('pref=Domain=y; Secure')).toBe('pref=Domain=y; Secure');
    expect(stripSetCookieDomain('mydomain=1; Max-Age=60')).toBe('mydomain=1; Max-Age=60');
  });
});

describe('forwardRequest', () => {
  let upstream: Server;
  let upstreamUrl: URL;
  let listener: Server;
  let listenerPort: number;
  let options: ForwardOptions;

  const OWN = 'https://calm-river-12.trycloudflare.com';

  beforeEach(async () => {
    upstream = createServer((req, res) => {
      const to = new URL(req.url ?? '/', 'http://app').searchParams.get('to');
      if (to !== null) {
        res.writeHead(302, { location: to }).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': ['sid=1; Domain=localhost; Path=/; HttpOnly'],
      });
      res.end(JSON.stringify(req.headers));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
    options = {
      upstream: upstreamUrl,
      own: OWN,
      dropCookies: ['__cezar_share'],
      injectHtml: (html) => html,
      unreachable: 'The app is not running right now.',
    };
    listener = createServer((req, res) => forwardRequest(req, res, options));
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    listenerPort = (listener.address() as AddressInfo).port;
  });

  afterEach(async () => {
    listener.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });

  function send(headers: Record<string, string>, path = '/echo'): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: listenerPort, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('forwards without the share cookie, and rewrites Origin only when it is its own', async () => {
    const own = await send({ host: 'calm-river-12.trycloudflare.com', origin: OWN, cookie: 'a=1; __cezar_share=secret' });
    const seenOwn = JSON.parse(own.body) as IncomingHttpHeaders;
    expect(seenOwn.cookie).toBe('a=1');
    expect(seenOwn.origin).toBe(upstreamUrl.origin);
    expect(seenOwn.host).toBe(upstreamUrl.host);
    expect(own.headers['set-cookie']).toEqual(['sid=1; Path=/; HttpOnly']);

    const foreign = await send({ host: 'calm-river-12.trycloudflare.com', origin: 'https://evil.example', cookie: '__cezar_share=secret' });
    const seenForeign = JSON.parse(foreign.body) as IncomingHttpHeaders;
    expect(seenForeign.cookie).toBeUndefined();
    expect(seenForeign.origin).toBe('https://evil.example');
  });

  it('without dropCookies (the mirror) passes Cookie and Set-Cookie through untouched', async () => {
    delete options.dropCookies;
    const res = await send({ host: 'calm-river-12.trycloudflare.com', cookie: 'a=1; __cezar_share=secret' });
    expect((JSON.parse(res.body) as IncomingHttpHeaders).cookie).toBe('a=1; __cezar_share=secret');
    expect(res.headers['set-cookie']).toEqual(['sid=1; Domain=localhost; Path=/; HttpOnly']);
  });

  it('keeps a redirect to the app on its own origin, and only when the origin really is the app', async () => {
    const redirected = async (to: string): Promise<string | undefined> =>
      (await send({ host: 'calm-river-12.trycloudflare.com' }, `/go?to=${encodeURIComponent(to)}`)).headers.location;
    const app = upstreamUrl.origin;
    expect(await redirected(`${app}/landed?x=1`)).toBe(`${OWN}/landed?x=1`);
    expect(await redirected(app)).toBe(OWN);
    expect(await redirected(`${app}?x=1`)).toBe(`${OWN}?x=1`);
    expect(await redirected(`${app}#top`)).toBe(`${OWN}#top`);
    // Another port that only STARTS like the app's: a prefix match turned it into `<own>1/x`.
    expect(await redirected(`${app}1/x`)).toBe(`${app}1/x`);
    expect(await redirected(`${app}.evil.example/x`)).toBe(`${app}.evil.example/x`);
    expect(await redirected(`${app}@evil.example/x`)).toBe(`${app}@evil.example/x`);
  });

  it('answers 502 with its own sentence when the app is not listening', async () => {
    // The closed port itself: `afterEach` closing it again only reports an error to its callback.
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    const res = await send({ host: 'calm-river-12.trycloudflare.com' });
    expect(res.status).toBe(502);
    expect(res.body).toBe('The app is not running right now.');
  });
});
