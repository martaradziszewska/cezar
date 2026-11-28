import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv, getJson, stopFixtureServer } from './agent-browser'

/**
 * Asset Share end to end (spec 2026-11-28-asset-share-link). `CEZ_DRY_RUN=1` swaps the cloudflared
 * tunnel for a loopback fake, so the "public" link is the share listener's own `127.0.0.1` address
 * and nothing leaves the machine.
 *
 * Two agent-browser sessions, two browsers: the owner's cockpit and the guest, with separate
 * cookies. The guest comments through the real bar: the shell is ordinary DOM, and the click on
 * the mockup's element is a real pointer at a coordinate inside the sandboxed frame.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const MARKER = 'Shared mockup 7f3a'

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the asset-share server never answered at ${url}`)
}

async function waitForStatus(url: string, id: string, wanted: string[]): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = await getJson<{ status: string }>(`${url}/api/v1/runs/${id}`)
    if (wanted.includes(record.status)) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached status "${wanted.join('/')}"`)
}

/** A synchronous same-origin request from inside the page: no promise for the provider to await. */
function xhr(path: string): string {
  return `(() => { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(path)}, false); x.send(); return x.status + ' ' + x.responseText })()`
}

/** Click the first button in `scope` whose text is exactly `label` (Radix menus are portalled). */
function clickButton(page: AgentBrowser, scope: string, label: string): void {
  page.waitForFunction(
    `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].some((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`,
  )
  page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled).click() ?? true`,
  )
}

// The button sits at a fixed place so the guest can click it through the frame by coordinate: the
// frame is an opaque origin and no selector reaches into it. Its text changes once the page's own
// relative image has loaded, which only happens if the view key serves it without a cookie (C14).
const MOCKUP = `<!doctype html>
<html><head><meta charset="utf-8"><title>Settings mockup</title>
<style>body{margin:0;font:16px sans-serif}h1{position:absolute;left:100px;top:20px;margin:0}.btn-primary{position:absolute;left:100px;top:100px;width:320px;height:60px}</style></head>
<body><h1>${MARKER}</h1><button class="btn-primary" type="button">Save changes</button>
<img id="shot" src="shot.png" width="10" height="10" alt="">
<script>document.getElementById('shot').addEventListener('load', function () { document.querySelector('.btn-primary').textContent = 'Save changes, image loaded' })</script>
</body></html>
`
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

let owner: AgentBrowser
let guest: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let runId: string
let shareUrl: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-share-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# asset-share e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)

  const created = (await (
    await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Design the settings page.', workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  runId = created.id
  await waitForStatus(baseUrl, runId, ['waiting'])

  // The mockup under review, beside the mock agent's own demo page.
  const assets = join(dataRoot, '.ai', 'cezar', 'artifacts', runId)
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(assets, 'mockup.html'), MOCKUP, 'utf8')
  writeFileSync(join(assets, 'shot.png'), PNG)

  owner = AgentBrowser.open(`e2e-share-owner-${process.pid}`)
  owner.setViewport(1440, 900)
  guest = AgentBrowser.open(`e2e-share-guest-${process.pid}`)
  guest.setViewport(1280, 800)
}, 180_000)

afterAll(async () => {
  owner?.close()
  guest?.close()
  await stopFixtureServer(server, dataRoot)
})

describe('sharing an HTML asset with a guest', () => {
  it('creates a link from the Assets toolbar', async () => {
    owner.goto(`${baseUrl}/tasks/${runId}/assets/mockup.html`)
    owner.waitForFunction(`document.querySelector('[data-slot="assets-frame"]') !== null`)
    owner.waitForFunction(`document.querySelector('[data-slot="share-idle"]') !== null`)
    owner.click('[data-slot="share-idle"]')
    owner.waitForFunction(`document.querySelector('[data-slot="share-confirm"]')?.textContent.includes('Traffic passes through Cloudflare.')`)
    clickButton(owner, '[data-slot="share-confirm"]', 'Create link')
    owner.waitForFunction(`document.querySelector('[data-slot="share-live"]') !== null`)

    const state = await getJson<{ share: { url: string; asset: string; assetTitle: string } | null }>(`${baseUrl}/api/v1/runs/${runId}/asset-share`)
    expect(state.share?.asset).toBe('mockup.html')
    expect(state.share?.assetTitle).toBe('Settings mockup')
    shareUrl = state.share!.url
    // The dry-run tunnel is the listener's own loopback address.
    expect(shareUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__cezar_share__\/join\/[a-f0-9]{64}$/)

    // Visible outside the Assets tab too (C7): the workspace bar.
    owner.waitForFunction(`document.querySelector('[data-slot="live-shares-label"]')?.textContent === '1 live link'`)
    owner.screenshot(`${artifactsDir}/asset-share-toolbar.png`, { viewport: true })
  })

  it('keeps a new visitor on the waiting page, with a code, and serves them nothing of the asset', () => {
    guest.goto(shareUrl)
    guest.waitForFunction(`document.getElementById('name') !== null`)
    guest.fill('#name', 'Ana')
    guest.click('#submit')
    guest.waitForFunction(`/^Your code: \\d{4}$/.test(document.getElementById('code')?.textContent ?? '')`)
    const code = guest.text('#code').replace('Your code: ', '')
    expect(code).toMatch(/^\d{4}$/)
    guest.screenshot(`${artifactsDir}/asset-share-waiting.png`, { viewport: true })

    // Not let in yet: neither the shell nor the asset is served to this browser.
    expect(String(guest.evaluate(xhr('/')))).not.toContain('id="asset"')
    expect(String(guest.evaluate(xhr(`/__cezar_share__/a/${'0'.repeat(64)}/mockup.html`)))).toMatch(/^404 /)

    // The owner sees the same name and code, from any screen (C12).
    owner.waitForFunction(`document.querySelector('[data-slot="live-shares-label"]')?.textContent === '1 live link · 1 waiting'`)
    owner.click('[data-slot="share-live"]')
    owner.waitForFunction(
      `[...document.querySelectorAll('[data-slot="share-guest-label"]')].some((n) => n.textContent === ${JSON.stringify(`Ana · ${code} wants to join`)})`,
    )
    owner.screenshot(`${artifactsDir}/asset-share-owner-menu.png`, { viewport: true })
    clickButton(owner, '[data-slot="share-menu"]', 'Allow')
  })

  it('shows the visitor the mockup in a sandboxed frame once the owner allows them', () => {
    guest.waitForFunction(`document.getElementById('asset') !== null`)
    const src = String(guest.evaluate(`document.getElementById('asset').getAttribute('src')`))
    expect(src).toMatch(/^\/__cezar_share__\/a\/[a-f0-9]{64}\/mockup\.html$/)
    expect(guest.text('[data-slot="name"]')).toBe('Ana')

    // The frame's own answer sandboxes it (C15): scripts only, no popups, and no way to another site.
    const headers = String(
      guest.evaluate(
        `(() => { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(src)}, false); x.send(); return x.getResponseHeader('content-security-policy') + ' ## ' + x.responseText })()`,
      ),
    )
    expect(headers).toContain('sandbox allow-scripts;')
    expect(headers).toContain("connect-src 'none'")
    expect(headers).toContain(MARKER)
    // Another HTML asset of the same task is not part of this link.
    expect(String(guest.evaluate(xhr(src.replace('mockup.html', 'demo.html'))))).toMatch(/^404 /)
  })

  it('lets the guest comment on an element through the bar, and delivers it under their name', async () => {
    // Comment off: a click is the mockup's own, and nothing opens.
    guest.tapAt(260, 130)
    expect(guest.evaluate(`document.querySelector('[data-slot="popup"]').hidden`)).toBe(true)

    guest.click('[data-slot="toggle"]')
    guest.waitForFunction(`document.querySelector('[data-slot="toggle"]').getAttribute('aria-pressed') === 'true'`)
    // The picker in the frame reports the click to the shell, which opens the popup beside it.
    for (let attempt = 0; attempt < 20 && guest.evaluate(`document.querySelector('[data-slot="popup"]').hidden`) === true; attempt += 1) {
      guest.tapAt(260, 130)
      await new Promise((r) => setTimeout(r, 300))
    }
    guest.waitForFunction(`document.querySelector('[data-slot="popup"]').hidden === false`)
    expect(guest.text('[data-slot="element"]')).toContain('button.btn-primary')
    guest.fill('[data-slot="body"]', 'Too grey, it reads as disabled.')
    guest.screenshot(`${artifactsDir}/asset-share-guest-comment.png`, { viewport: true })
    guest.click('[data-slot="save"]')
    guest.waitForFunction(`document.querySelector('[data-slot="count"]').textContent === '1'`)

    const stored = await getJson<{ comments: { asset: string; author: string; label: string; selector: string; body: string }[] }>(
      `${baseUrl}/api/v1/runs/${runId}/guest-comments`,
    )
    expect(stored.comments).toHaveLength(1)
    expect(stored.comments[0]).toMatchObject({ asset: 'mockup.html', author: 'Ana', body: 'Too grey, it reads as disabled.' })
    expect(stored.comments[0]!.selector).toContain('button.btn-primary')
    // The page's relative image loaded inside the sandboxed frame, with no cookie (C14).
    expect(stored.comments[0]!.label).toBe('Save changes, image loaded')

    owner.press('Escape')
    owner.goto(`${baseUrl}/tasks/${runId}/chat`)
    owner.waitForFunction(
      `[...document.querySelectorAll('[data-slot="diff-comment-chip"][data-kind="guest"]')].some((n) => n.textContent.includes('Ana · '))`,
    )
    expect(owner.text('[data-slot="diff-comment-chip"][data-kind="guest"]')).toContain('Ana · ')
    // The task's sidebar row wears the Sharing badge.
    expect(owner.count(`[data-run-id="${runId}"] [data-slot="task-share-badge"]`)).toBe(1)
    owner.screenshot(`${artifactsDir}/asset-share-composer.png`, { viewport: true })
  })

  it('stops answering once the owner stops sharing', async () => {
    owner.waitForFunction(`document.querySelector('[data-slot="live-shares"] button') !== null`)
    owner.click('[data-slot="live-shares"] button')
    clickButton(owner, '[aria-label="Live links"]', 'Stop sharing')
    owner.waitForFunction(`document.querySelector('[data-slot="live-shares"]') === null`)
    expect((await getJson<{ share: unknown }>(`${baseUrl}/api/v1/runs/${runId}/asset-share`)).share).toBeNull()

    // The listener is gone with the share: the link no longer reaches anything.
    let answered: string = 'refused'
    try {
      const res = await fetch(shareUrl, { redirect: 'manual' })
      answered = `${res.status} ${await res.text()}`
    } catch {
      /* connection refused: the listener closed */
    }
    expect(answered === 'refused' || answered.includes('no longer active')).toBe(true)
    expect(answered).not.toContain(MARKER)
  })
})
