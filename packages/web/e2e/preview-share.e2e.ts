import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv, getJson, stopFixtureServer } from './agent-browser'

/**
 * Preview Share end to end (spec 2026-11-26-preview-share-link). `CEZ_DRY_RUN=1` swaps the
 * cloudflared tunnel for a loopback fake, so the "public" link is the share listener's own
 * `127.0.0.1` address and nothing leaves the machine. The shared app is a tiny static server this
 * spec owns: the server refuses to share anything that answers as a cezar (C10).
 *
 * The app runs in a child process: every agent-browser call blocks this one (`execFileSync`), so an
 * in-process server could not answer the page the browser is waiting on.
 *
 * Two agent-browser sessions, two browsers: the owner's cockpit and the guest, with separate
 * cookies. The guest's comment is posted from the guest's real page with a same-origin XHR rather
 * than through the corner bar, whose closed shadow root no selector can reach; it still carries the
 * browser's own `Origin` and the share cookie, which is what the listener checks.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const MARKER = 'Shared app content 7f3a'

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
  throw new Error(`cezar e2e: the preview-share server never answered at ${url}`)
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
function xhr(method: 'GET' | 'POST', path: string, body?: unknown): string {
  const send = body === undefined ? 'x.send()' : `x.setRequestHeader('content-type', 'application/json'); x.send(${JSON.stringify(JSON.stringify(body))})`
  return `(() => { const x = new XMLHttpRequest(); x.open(${JSON.stringify(method)}, ${JSON.stringify(path)}, false); ${send}; return x.status + ' ' + x.responseText })()`
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

let owner: AgentBrowser
let guest: AgentBrowser
let server: ChildProcess
let app: ChildProcess
let dataRoot: string
let baseUrl: string
let appOrigin: string
let runId: string
let shareUrl: string

beforeAll(async () => {
  const appPort = await freePort()
  const page = `<!doctype html><html><head><title>Fixture app</title></head><body><main><h1>${MARKER}</h1><button class="btn-primary" type="button">Save</button></main></body></html>`
  app = spawn(
    process.execPath,
    [
      '-e',
      `require('node:http').createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); s.end(${JSON.stringify(page)}) }).listen(${appPort}, '127.0.0.1')`,
    ],
    { stdio: 'ignore' },
  )
  appOrigin = `http://127.0.0.1:${appPort}`
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${appOrigin}/`)).ok) break
    } catch {
      if (attempt >= 40) throw new Error('cezar e2e: the fixture app never answered')
    }
    await new Promise((r) => setTimeout(r, 250))
  }

  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-share-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# preview-share e2e fixture repo\n', 'utf8')
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
      body: JSON.stringify({ task: 'Brand the Save button.', workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  runId = created.id
  await waitForStatus(baseUrl, runId, ['waiting'])

  owner = AgentBrowser.open(`e2e-share-owner-${process.pid}`)
  owner.setViewport(1440, 900)
  guest = AgentBrowser.open(`e2e-share-guest-${process.pid}`)
  guest.setViewport(1280, 800)
}, 180_000)

afterAll(async () => {
  owner?.close()
  guest?.close()
  app?.kill()
  await stopFixtureServer(server, dataRoot)
})

describe('sharing a task preview with a guest', () => {
  it('creates a link from the Preview toolbar', async () => {
    owner.goto(`${baseUrl}/tasks/${runId}/preview`)
    owner.waitForFunction(`document.querySelector('input[aria-label="Address"]') !== null`)
    owner.fill('input[aria-label="Address"]', `${appOrigin}/`)
    owner.press('Enter')
    owner.waitForFunction(`document.querySelector('[data-slot="share-idle"]')?.disabled === false`)
    owner.click('[data-slot="share-idle"]')
    clickButton(owner, '[data-slot="share-confirm"]', 'Create link')
    owner.waitForFunction(`document.querySelector('[data-slot="share-live"]') !== null`)

    const state = await getJson<{ share: { url: string; target: string } | null }>(`${baseUrl}/api/v1/runs/${runId}/preview-share`)
    expect(state.share?.target).toBe(appOrigin)
    shareUrl = state.share!.url
    // The dry-run tunnel is the listener's own loopback address.
    expect(shareUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__cezar_share__\/join\//)

    // Visible outside the Preview too (C7): the workspace bar.
    owner.waitForFunction(`document.querySelector('[data-slot="live-shares-label"]')?.textContent === '1 live link'`)
  })

  it('keeps a new visitor on the waiting page, with a code, and serves them nothing of the app', () => {
    guest.goto(shareUrl)
    guest.waitForFunction(`document.getElementById('name') !== null`)
    guest.fill('#name', 'Ana')
    guest.click('#submit')
    guest.waitForFunction(`/^Your code: \\d{4}$/.test(document.getElementById('code')?.textContent ?? '')`)
    const code = guest.text('#code').replace('Your code: ', '')
    expect(code).toMatch(/^\d{4}$/)
    guest.screenshot(`${artifactsDir}/preview-share-waiting.png`, { viewport: true })

    // Not let in yet: the app's page is not served to this browser.
    expect(String(guest.evaluate(xhr('GET', '/')))).not.toContain(MARKER)

    // The owner sees the same name and code, from any screen (C12).
    owner.waitForFunction(`document.querySelector('[data-slot="live-shares-label"]')?.textContent === '1 live link · 1 waiting'`)
    owner.click('[data-slot="share-live"]')
    owner.waitForFunction(
      `[...document.querySelectorAll('[data-slot="share-guest-label"]')].some((n) => n.textContent === ${JSON.stringify(`Ana · ${code} wants to join`)})`,
    )
    owner.screenshot(`${artifactsDir}/preview-share-owner-menu.png`, { viewport: true })
    clickButton(owner, '[data-slot="share-menu"]', 'Allow')
  })

  it('lets the visitor in once the owner allows them', () => {
    guest.waitForFunction(`document.body.innerText.includes(${JSON.stringify(MARKER)})`)
    // The guest bar was injected into the app's document.
    expect(guest.count('cezar-share-guest')).toBe(1)
    guest.screenshot(`${artifactsDir}/preview-share-guest-app.png`, { viewport: true })
  })

  it('delivers the guest’s comment to the owner’s composer under the guest’s name', () => {
    const answer = String(
      guest.evaluate(
        xhr('POST', '/__cezar_share__/comments', {
          url: `${appOrigin}/`,
          selector: 'main > button.btn-primary',
          label: 'Save',
          excerpt: '<button class="btn-primary" type="button">Save</button>',
          body: 'Make this the brand green.',
        }),
      ),
    )
    // 201 only with the share cookie and an Origin equal to the listener's (spec § Exposure).
    expect(answer.startsWith('201 ')).toBe(true)

    owner.press('Escape')
    // The Preview stays this task's remembered view, so ask for the chat (and its composer) by name.
    owner.goto(`${baseUrl}/tasks/${runId}/chat`)
    owner.waitForFunction(
      `[...document.querySelectorAll('[data-slot="diff-comment-chip"][data-kind="guest"]')].some((n) => n.textContent.includes('Ana · '))`,
    )
    expect(owner.text('[data-slot="diff-comment-chip"][data-kind="guest"]')).toContain('Ana · ')
    // The task's sidebar row wears the Sharing badge.
    expect(owner.count(`[data-run-id="${runId}"] [data-slot="task-share-badge"]`)).toBe(1)
    owner.screenshot(`${artifactsDir}/preview-share-composer.png`, { viewport: true })
  })

  it('stops answering once the owner stops sharing', async () => {
    owner.waitForFunction(`document.querySelector('[data-slot="live-shares"] button') !== null`)
    owner.click('[data-slot="live-shares"] button')
    clickButton(owner, '[aria-label="Live links"]', 'Stop sharing')
    owner.waitForFunction(`document.querySelector('[data-slot="live-shares"]') === null`)
    expect((await getJson<{ share: unknown }>(`${baseUrl}/api/v1/runs/${runId}/preview-share`)).share).toBeNull()

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
