import { afterEach, describe, expect, it, vi } from 'vitest'

// The guest script is the SERVER's (the share listener serves it), but it is a browser script and
// this is the workspace with a DOM to run it in — the same test-only reach as design-picker.test.ts.
import { guestScript } from '../../../../cezar/src/server/preview/share-guest-script.ts'

/**
 * The share link's guest script (spec 2026-11-26-preview-share-link § Mechanism 8), run for real in
 * a TOP-LEVEL page at the tunnel's address: the Design Mode picker with an in-page host.
 */

const ENDED = 'This link has ended — your comment was not saved.'
const LIME = 'rgb(163, 230, 53)'

type Answer = { status: number; body?: unknown } | 'offline'
interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A fresh top-level window per case, at a real path. jsdom ships no types; vitest's jsdom
 *  environment exposes its own instance as `globalThis.jsdom`, whose class makes another. */
interface Dom {
  window: Window
}
const JSDOM = (globalThis as unknown as { jsdom: { constructor: new (html: string, options: object) => Dom } }).jsdom.constructor

let dom: Dom
let win: Window & typeof globalThis
let root: ShadowRoot
let calls: Call[]
let answers: Array<Answer | Promise<Answer>>
let appClicks: number

/** Let fetch answers and their `.then`s land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** An answer the test hands out later — a request still in flight over the tunnel. */
function later() {
  let answer!: (value: Answer) => void
  const promise = new Promise<Answer>((resolve) => (answer = resolve))
  return { promise, answer }
}

/** With `handTicked`: every interval the script armed. The test fires them, so no test waits on a clock. */
let intervals: Array<() => void>
async function tick(times = 1) {
  for (let turn = 0; turn < times; turn += 1) {
    for (const fire of [...intervals]) fire()
    await settle()
  }
}

function boot({
  path = '/settings',
  name = 'Ana',
  stored = [] as unknown[],
  handTicked = false,
}: { path?: string; name?: string; stored?: unknown[]; handTicked?: boolean } = {}) {
  dom = new JSDOM(
    '<!doctype html><html><head></head><body><main><h1 id="title">Settings</h1><button class="save">Save</button></main></body></html>',
    { url: `https://abc.trycloudflare.com${path}`, runScripts: 'outside-only', pretendToBeVisual: true },
  )
  win = dom.window as unknown as Window & typeof globalThis
  appClicks = 0
  win.document.querySelector('.save')!.addEventListener('click', () => appClicks++)
  calls = []
  answers = [{ status: 200, body: { comments: stored } }]
  win.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const answer = await (answers.shift() ?? { status: 500 })
    if (answer === 'offline') throw new TypeError('Failed to fetch')
    return {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: async () => {
        if (answer.body === undefined) throw new SyntaxError('no body')
        return answer.body
      },
    }
  }) as unknown as typeof fetch
  // The host's shadow root is closed; the test keeps a handle the way a debugger would.
  const attach = win.Element.prototype.attachShadow
  win.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const made = attach.call(this, init)
    root = made
    return made
  }
  intervals = []
  if (handTicked) {
    win.setInterval = ((fire: () => void) => intervals.push(fire)) as unknown as typeof win.setInterval
    win.clearInterval = (() => {}) as typeof win.clearInterval
  }
  ;(win as unknown as { eval(source: string): unknown }).eval(guestScript({ upstreamOrigin: 'http://localhost:5173', name }))
}

afterEach(() => dom?.window.close())

const button = () => win.document.querySelector('.save')!
const title = () => win.document.querySelector('#title')!
const shadow = <T extends Element>(selector: string) => root.querySelector<T>(selector)
const toggle = () => shadow<HTMLButtonElement>('[data-slot=toggle]')!
const popup = () => shadow<HTMLElement>('[data-slot=popup]')!
const textarea = () => shadow<HTMLTextAreaElement>('textarea')!
const popupOpen = () => !popup().hidden
const popupText = () => textarea().value
const popupMessage = () => shadow<HTMLElement>('[data-slot=message]')!.textContent
const marks = () => [...win.document.querySelectorAll<HTMLElement>('[data-cezar-design=mark]')]
const posts = () => calls.filter((call) => call.method !== 'GET')
const lastPost = () => posts().at(-1)!

function click(target: Element) {
  target.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
}
function toggleCommentMode() {
  toggle().click()
}
function type(text: string) {
  textarea().value = text
  textarea().dispatchEvent(new win.Event('input', { bubbles: true }))
}
function popupButton(label: string) {
  return [...root.querySelectorAll<HTMLButtonElement>('[data-slot=popup] button')].find((b) => b.textContent === label && !b.hidden)
}
async function save() {
  popupButton('Save')!.click()
  await settle()
}
function key(target: EventTarget, init: KeyboardEventInit) {
  const event = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init })
  target.dispatchEvent(event)
  return event
}

function stored(id: string, url: string, body = 'old words') {
  return { id, revision: 1, author: 'Ana', createdAt: '2026-11-26T10:00:00.000Z', url, selector: 'body > main > button.save', label: 'Save', excerpt: '<button class="save">Save</button>', body }
}

describe('commenting', () => {
  it('runs unframed and saves a picked element with the app address, not the page address', async () => {
    boot()
    await settle()
    expect(win.parent).toBe(win)
    toggleCommentMode()
    click(button())
    expect(popupOpen()).toBe(true)
    type('make it green')
    answers.push({ status: 201, body: { comment: stored('c1', 'http://localhost:5173/settings', 'make it green') } })
    await save()

    expect(lastPost().url).toBe('/__cezar_share__/comments')
    expect(lastPost().method).toBe('POST')
    expect(lastPost().headers['content-type']).toBe('application/json')
    expect(lastPost().body).toMatchObject({
      url: 'http://localhost:5173/settings',
      selector: expect.stringContaining('button'),
      label: 'Save',
      excerpt: '<button class="save">Save</button>',
      body: 'make it green',
    })
    // Saved: the popup closes and the frame stays, numbered.
    expect(popupOpen()).toBe(false)
    expect(marks()).toHaveLength(1)
    expect(marks()[0]!.style.borderColor).toBe(LIME)
    expect(marks()[0]!.textContent).toBe('1')
    expect(shadow('[data-slot=count]')!.textContent).toBe('1')
    // The click was the pick: the app's own handler never ran.
    expect(appClicks).toBe(0)
  })

  it('keeps the typed text when the share has ended', async () => {
    boot()
    await settle()
    toggleCommentMode()
    click(button())
    type('still here')
    answers.push({ status: 404, body: { error: 'This link is no longer active.' } })
    await save()
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('still here')
    expect(popupMessage()).toBe(ENDED)
  })

  it.each([
    [{ status: 409, body: { error: "The reviewer's inbox is full." } } as Answer, "The reviewer's inbox is full."],
    [{ status: 429, body: { error: 'Too many changes at once. Try again in a minute.' } } as Answer, 'Too many changes at once. Try again in a minute.'],
    [{ status: 502 } as Answer, 'Your comment could not be saved. Try again.'],
    ['offline' as Answer, 'Your comment could not be saved. Try again.'],
  ])('keeps the popup and says why a save failed (%#)', async (answer, message) => {
    boot()
    await settle()
    toggleCommentMode()
    click(button())
    type('words')
    answers.push(answer)
    await save()
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('words')
    expect(popupMessage()).toBe(message)
  })

  it('saves with Ctrl+Enter and closes with Esc, keeping both keys from the app', async () => {
    boot()
    await settle()
    let appKeys = 0
    win.document.addEventListener('keydown', () => appKeys++)
    toggleCommentMode()
    click(button())
    expect(key(textarea(), { key: 'Escape' }).defaultPrevented).toBe(true)
    expect(popupOpen()).toBe(false)
    expect(marks()).toHaveLength(0)

    click(title())
    type('bigger')
    answers.push({ status: 201, body: { comment: { ...stored('c2', 'http://localhost:5173/settings', 'bigger'), selector: 'body > main > h1#title' } } })
    key(textarea(), { key: 'Enter', ctrlKey: true })
    await settle()
    expect(lastPost().body).toMatchObject({ body: 'bigger', selector: 'h1#title' })
    expect(popupOpen()).toBe(false)
    expect(appKeys).toBe(0)
  })

  it('edits and deletes a saved comment in place, and keeps the text when the link has ended', async () => {
    boot({ stored: [stored('c1', 'http://localhost:5173/settings')] })
    await settle()
    toggleCommentMode()
    click(button())
    expect(popupText()).toBe('old words')
    expect(popupButton('Delete')).toBeDefined()

    type('new words')
    answers.push({ status: 200, body: { comment: { ...stored('c1', 'http://localhost:5173/settings', 'new words'), revision: 2 } } })
    await save()
    expect(lastPost()).toMatchObject({ url: '/__cezar_share__/comments/c1', method: 'PUT', body: { body: 'new words' } })
    expect(popupOpen()).toBe(false)

    click(button())
    expect(popupText()).toBe('new words')
    answers.push({ status: 404, body: { error: 'That comment is no longer there.' } })
    popupButton('Delete')!.click()
    await settle()
    expect(lastPost()).toMatchObject({ url: '/__cezar_share__/comments/c1', method: 'DELETE', body: {} })
    expect(lastPost().headers['content-type']).toBe('application/json')
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('new words')
    expect(popupMessage()).toBe(ENDED)

    answers.push({ status: 204 })
    popupButton('Delete')!.click()
    await settle()
    expect(popupOpen()).toBe(false)
    expect(marks()).toHaveLength(0)
    expect(shadow('[data-slot=count]')!.textContent).toBe('0')
  })
})

describe('a save in flight', () => {
  /** Every way to close the popup, tried while the answer is still on its way. */
  function tryToClose() {
    key(textarea(), { key: 'Escape' })
    popupButton('Cancel')!.click()
    key(win.document.body, { key: 'Escape' }) // Esc in the app, comment mode on
  }

  it('keeps a new comment open until its answer, and shows why it was not saved', async () => {
    boot()
    await settle()
    toggleCommentMode()
    click(button())
    type('mid flight')
    const pending = later()
    answers.push(pending.promise)
    key(textarea(), { key: 'Enter', ctrlKey: true })
    expect(popupButton('Cancel')!.disabled).toBe(true)
    tryToClose()
    expect(popupOpen()).toBe(true)
    pending.answer({ status: 404, body: { error: 'This link is no longer active.' } })
    await settle()
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('mid flight')
    expect(popupMessage()).toBe(ENDED)
    expect(popupButton('Cancel')!.disabled).toBe(false)
  })

  it('keeps an edit open until its answer, and shows why it was not saved', async () => {
    boot({ stored: [stored('c1', 'http://localhost:5173/settings')] })
    await settle()
    toggleCommentMode()
    click(button())
    type('edited mid flight')
    const pending = later()
    answers.push(pending.promise)
    popupButton('Save')!.click()
    tryToClose()
    expect(popupOpen()).toBe(true)
    pending.answer({ status: 404, body: { error: 'That comment is no longer there.' } })
    await settle()
    expect(lastPost()).toMatchObject({ method: 'PUT' })
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('edited mid flight')
    expect(popupMessage()).toBe(ENDED)
  })

  it('keeps unsaved text when Esc is pressed in the app, and closes an empty comment', async () => {
    boot()
    await settle()
    toggleCommentMode()
    click(button())
    type('not yet saved')
    key(win.document.body, { key: 'Escape' })
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('not yet saved')
    type('')
    key(win.document.body, { key: 'Escape' })
    expect(popupOpen()).toBe(false)
  })

  it("sends through the page's fetch as it was when the script started, not the app's wrapper", async () => {
    boot()
    await settle()
    const wrapper = vi.fn(() => Promise.reject(new Error('the app broke it')))
    win.fetch = wrapper as unknown as typeof fetch
    toggleCommentMode()
    click(button())
    type('words')
    answers.push({ status: 201, body: { comment: stored('c1', 'http://localhost:5173/settings', 'words') } })
    await save()
    expect(wrapper).not.toHaveBeenCalled()
    expect(lastPost().body).toMatchObject({ body: 'words' })
    expect(popupOpen()).toBe(false)
  })
})

describe('marks', () => {
  it('frames a saved comment whose element the app draws after load', async () => {
    boot({ stored: [{ ...stored('c1', 'http://localhost:5173/settings'), selector: 'body > main > button.later' }] })
    await settle()
    expect(marks()).toHaveLength(0)
    const late = win.document.createElement('button')
    late.className = 'later'
    win.document.querySelector('main')!.appendChild(late)
    await wait(600)
    expect(marks()).toHaveLength(1)
    expect(marks()[0]!.textContent).toBe('1')
  })

  it('stops looking for a missing element after a few tries, until the path changes', async () => {
    const selector = 'body > main > button.gone'
    boot({ stored: [{ ...stored('c1', 'http://localhost:5173/settings'), selector }], handTicked: true })
    let searches = 0
    const search = win.document.querySelectorAll.bind(win.document)
    win.document.querySelectorAll = ((query: string) => {
      if (query === selector) searches++
      return search(query)
    }) as typeof win.document.querySelectorAll
    await settle()
    // The load's own search, then one for each of six polls.
    expect(searches).toBe(1)
    for (let poll = 1; poll <= 6; poll += 1) {
      await tick()
      expect(searches).toBe(1 + poll)
    }
    // Then nothing, however long the page stays open.
    await tick(10)
    expect(searches).toBe(7)
    win.history.pushState({}, '', '/elsewhere')
    win.dispatchEvent(new win.PopStateEvent('popstate'))
    await tick()
    win.history.pushState({}, '', '/settings')
    win.dispatchEvent(new win.PopStateEvent('popstate'))
    await tick()
    expect(searches).toBeGreaterThan(7)
  })

  it('marks only the comments of this page', async () => {
    boot({ stored: [stored('c1', 'http://localhost:5173/other'), stored('c2', 'http://localhost:5173/settings')] })
    await settle()
    expect(calls[0]).toMatchObject({ url: '/__cezar_share__/comments', method: 'GET' })
    expect(marks()).toHaveLength(1)
    expect(marks()[0]!.textContent).toBe('1')
    // The count is all of this guest's comments, every page.
    expect(shadow('[data-slot=count]')!.textContent).toBe('2')
  })

  it('follows the app to another path without a page load', async () => {
    boot({ stored: [stored('c1', 'http://localhost:5173/other')] })
    await settle()
    expect(marks()).toHaveLength(0)
    win.history.pushState({}, '', '/other')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(marks()).toHaveLength(1)
    win.history.pushState({}, '', '/settings')
    win.dispatchEvent(new win.PopStateEvent('popstate'))
    expect(marks()).toHaveLength(0)
  })
})

describe('the page is the app’s', () => {
  it('leaves the page alone while comment mode is off', async () => {
    boot()
    await settle()
    click(button())
    expect(appClicks).toBe(1)
    expect(popupOpen()).toBe(false)
    expect(key(win.document.body, { key: 'Escape' }).defaultPrevented).toBe(false)
    expect(key(win.document.body, { code: 'KeyD', key: 'd', altKey: true }).defaultPrevented).toBe(false)

    // On, then off again with the same button: the app gets its clicks back.
    toggleCommentMode()
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    click(button())
    expect(appClicks).toBe(1)
    key(textarea(), { key: 'Escape' })
    toggleCommentMode()
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    click(button())
    expect(appClicks).toBe(2)
  })

  it('adds one host element and only its two globals', async () => {
    boot()
    await settle()
    const own = Object.keys(win).filter((k) => k.startsWith('__cezar'))
    expect(own.sort()).toEqual(['__cezarShareHost', '__cezarSharePicker'])
    expect(win.document.documentElement.lastElementChild!.shadowRoot).toBeNull() // closed
    expect(win.document.head.children).toHaveLength(0)
  })

  it('shows a stranger-chosen name as text, and the script stays one script', async () => {
    const name = '</script><img src=x onerror="window.pwned=1">\u2028'
    const source = guestScript({ upstreamOrigin: 'http://localhost:5173', name })
    expect(source).not.toContain('</script')
    expect(source).not.toContain('\u2028')
    boot({ name })
    await settle()
    expect(shadow('[data-slot=name]')!.textContent).toBe(name)
    expect(root.querySelector('img')).toBeNull()
  })

  it('labels the bar and popup with the given words', async () => {
    boot()
    await settle()
    expect(toggle().textContent).toBe('Comment')
    toggleCommentMode()
    click(button())
    expect(textarea().placeholder).toBe('Leave a comment…')
    expect(textarea().maxLength).toBe(2000)
    expect(popupButton('Cancel')).toBeDefined()
    expect(popupButton('Delete')).toBeUndefined()
    popupButton('Cancel')!.click()
    expect(popupOpen()).toBe(false)
    expect(marks()).toHaveLength(0)
  })
})
