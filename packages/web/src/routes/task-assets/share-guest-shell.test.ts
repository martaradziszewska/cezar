import { afterEach, describe, expect, it, vi } from 'vitest'

// The guest shell is the SERVER's (the share listener serves it), but it is a browser page and
// this is the workspace with a DOM to run it in — the same test-only reach as design-picker.test.ts.
import { guestShell, guestShellCsp } from '../../../../cezar/src/server/preview/share-guest-shell.ts'

/**
 * The share link's guest shell (spec 2026-11-28-asset-share-link § Mechanism 4 and 8), run for real
 * as a TOP-LEVEL page at the tunnel's address. The framed asset and its picker are played by the
 * test: what the shell posts to the frame is recorded, and the picker's messages are dispatched
 * with the frame's window as their source.
 */

const ENDED = 'This link has ended — your comment was not saved.'
const FRAME_SRC = '/__cezar_share__/a/0123abcd/settings-mockup.html'

type Answer = { status: number; body?: unknown } | 'offline'
interface Call {
  url: string
  method: string
  credentials: string | undefined
  headers: Record<string, string>
  body: unknown
}
interface Sent {
  message: Record<string, unknown>
  targetOrigin: unknown
}

/** jsdom ships no types; vitest's jsdom environment exposes its own instance as
 *  `globalThis.jsdom`, whose class makes another. */
interface Dom {
  window: Window
}
const JSDOM = (globalThis as unknown as { jsdom: { constructor: new (html: string, options: object) => Dom } }).jsdom.constructor

let dom: Dom
let win: Window & typeof globalThis
let frameWindow: Window
let calls: Call[]
let answers: Array<Answer | Promise<Answer>>
let sent: Sent[]
/** Every interval the shell armed. The test fires them, so no test waits on a clock. */
let intervals: Array<() => void>

/** Let fetch answers and their `.then`s land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** An answer the test hands out later — a request still in flight over the tunnel. */
function later() {
  let answer!: (value: Answer) => void
  const promise = new Promise<Answer>((resolve) => (answer = resolve))
  return { promise, answer }
}

function boot({
  name = 'Ana',
  stored = [] as unknown[],
  frameSrc = FRAME_SRC,
  title = 'Settings mockup',
}: { name?: string; stored?: unknown[]; frameSrc?: string; title?: string } = {}) {
  calls = []
  answers = [{ status: 200, body: { comments: stored } }]
  intervals = []
  dom = new JSDOM(guestShell({ name, frameSrc, nonce: 'bm9uY2U=', title }), {
    url: 'https://abc.trycloudflare.com/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    // Before the shell's own script: it reads the list the moment it runs.
    beforeParse(window: Window & typeof globalThis) {
      window.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({
          url,
          method: init.method ?? 'GET',
          credentials: init.credentials,
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
      window.setInterval = ((fire: () => void) => intervals.push(fire)) as unknown as typeof window.setInterval
    },
  })
  win = dom.window as unknown as Window & typeof globalThis
  frameWindow = frame().contentWindow!
  sent = []
  frameWindow.postMessage = ((message: Record<string, unknown>, targetOrigin: unknown) => {
    sent.push({ message, targetOrigin })
  }) as typeof frameWindow.postMessage
}

afterEach(() => dom?.window.close())

const frame = () => win.document.querySelector<HTMLIFrameElement>('iframe#asset')!
const slot = <T extends HTMLElement>(name: string) => win.document.querySelector<T>(`[data-slot="${name}"]`)!
const toggle = () => slot<HTMLButtonElement>('toggle')
const popup = () => slot('popup')
const textarea = () => slot<HTMLTextAreaElement>('body')
const popupOpen = () => !popup().hidden
const popupText = () => textarea().value
const popupMessage = () => slot('message').textContent
const count = () => slot('count').textContent
const writes = () => calls.filter((call) => call.method !== 'GET')
const lastWrite = () => writes().at(-1)!
const told = (type: string) => sent.filter((entry) => entry.message.type === type).map((entry) => entry.message)
const lastMarks = () => told('set-marks').at(-1)?.marks

/** A message as the framed picker posts it; `source` is whose window it claims to come from. */
function fromFrame(data: Record<string, unknown>, source: Window | null = frameWindow) {
  const event = new win.MessageEvent('message', { data: { source: 'cezar-design', ...data }, origin: 'null' })
  Object.defineProperty(event, 'source', { value: source })
  win.dispatchEvent(event)
}

function pick(mark = 'doc1-1', over: Record<string, unknown> = {}) {
  return {
    mark,
    url: FRAME_SRC,
    selector: 'body > main > button.save',
    tag: 'button',
    text: 'Save',
    html: '<button class="save">Save</button>',
    styles: {},
    rect: { x: 100, y: 50, width: 80, height: 20 },
    viewport: { width: 1024, height: 768 },
    components: [],
    source: '',
    ...over,
  }
}

function stored(id: string, body = 'old words', selector = 'body > main > button.save') {
  return {
    id,
    revision: 1,
    author: 'Ana',
    createdAt: '2026-11-28T10:00:00.000Z',
    asset: 'settings-mockup.html',
    selector,
    label: 'Save',
    excerpt: '<button class="save">Save</button>',
    body,
  }
}

/** The page has loaded its list and the frame's picker has reported in. */
async function start(options: Parameters<typeof boot>[0] = {}) {
  boot(options)
  await settle()
  fromFrame({ type: 'ready', url: FRAME_SRC })
}

function type(text: string) {
  textarea().value = text
  textarea().dispatchEvent(new win.Event('input', { bubbles: true }))
}
async function save() {
  slot<HTMLButtonElement>('save').click()
  await settle()
}
function key(target: EventTarget, init: KeyboardEventInit) {
  const event = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('the page', () => {
  it('frames the asset at the address it was given, and nothing sandboxes it here', () => {
    boot()
    expect(frame().getAttribute('src')).toBe(FRAME_SRC)
    // The asset's own response header is the sandbox: an attribute here would be a second, weaker one.
    expect(frame().hasAttribute('sandbox')).toBe(false)
    expect(frame().title).toBe('Settings mockup')
    expect(win.document.title).toBe('Settings mockup')
    expect(win.document.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('runs under a CSP with no inline style or handler: one nonce for its script and its style', () => {
    const html = guestShell({ name: 'Ana', frameSrc: FRAME_SRC, nonce: 'bm9uY2U=', title: 'T' })
    expect(html.match(/<script nonce="bm9uY2U=">/g)).toHaveLength(1)
    expect(html.match(/<style nonce="bm9uY2U=">/g)).toHaveLength(1)
    expect(html).not.toMatch(/\sstyle="/)
    expect(html).not.toMatch(/\son[a-z]+="/)
    expect(guestShellCsp('bm9uY2U=')).toBe(
      "default-src 'none'; script-src 'nonce-bm9uY2U='; style-src 'nonce-bm9uY2U='; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
  })

  it('shows a stranger-chosen name as text, and the page stays one page', async () => {
    const name = '</script><img src=x onerror="window.pwned=1">\u2028'
    const html = guestShell({ name, frameSrc: FRAME_SRC, nonce: 'bm9uY2U=', title: 'T' })
    expect(html.match(/<\/script/g)).toHaveLength(2)
    expect(html).not.toContain('\u2028')
    boot({ name })
    await settle()
    expect(slot('name').textContent).toBe(name)
    expect(win.document.querySelector('img')).toBeNull()
    expect((win as unknown as { pwned?: number }).pwned).toBeUndefined()
  })

  it('keeps an address and a title with markup in them inert', async () => {
    const hostile = '"><script>window.pwned=1</script><img src=x onerror="window.pwned=1">'
    boot({ frameSrc: `/__cezar_share__/a/k/${hostile}`, title: hostile })
    await settle()
    expect(frame().getAttribute('src')).toBe(`/__cezar_share__/a/k/${hostile}`)
    expect(win.document.title).toBe(hostile)
    expect(win.document.querySelector('img')).toBeNull()
    expect(win.document.querySelectorAll('script')).toHaveLength(2)
    expect((win as unknown as { pwned?: number }).pwned).toBeUndefined()
  })

  it('reads this guest’s comments with the cookie, and counts them', async () => {
    boot({ stored: [stored('c1'), stored('c2')] })
    await settle()
    expect(calls[0]).toMatchObject({ url: '/__cezar_share__/comments', method: 'GET', credentials: 'same-origin' })
    expect(count()).toBe('2')
    expect(toggle().textContent).toBe('Comment')
    expect(textarea().placeholder).toBe('Leave a comment…')
    expect(textarea().maxLength).toBe(2000)
  })
})

describe('comment mode', () => {
  it('sends nothing to a frame whose picker has not reported in', async () => {
    boot({ stored: [stored('c1')] })
    await settle()
    toggle().click()
    expect(sent).toHaveLength(0)
    // Once it does, it is told the state it missed.
    fromFrame({ type: 'ready' })
    expect(told('set-active')).toEqual([{ source: 'cezar-design-host', type: 'set-active', active: true }])
    expect(lastMarks()).toEqual([{ key: 'c1', n: 1, selector: 'body > main > button.save' }])
  })

  it('shows no marks while Comment is off, and numbers them once it is on', async () => {
    await start({ stored: [stored('c1'), stored('c2', 'second', 'body > main > h1#title')] })
    // Off: exploring shows the mockup, not frames.
    expect(lastMarks()).toEqual([])
    expect(told('set-active')).toEqual([])

    toggle().click()
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(told('set-active').at(-1)).toMatchObject({ active: true })
    expect(lastMarks()).toEqual([
      { key: 'c1', n: 1, selector: 'body > main > button.save' },
      { key: 'c2', n: 2, selector: 'body > main > h1#title' },
    ])

    toggle().click()
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(told('set-active').at(-1)).toMatchObject({ active: false })
    expect(lastMarks()).toEqual([])
  })

  it('posts with "*" and its own source: an opaque origin cannot be named', async () => {
    await start()
    toggle().click()
    expect(sent.length).toBeGreaterThan(0)
    for (const entry of sent) {
      expect(entry.targetOrigin).toBe('*')
      expect(entry.message.source).toBe('cezar-design-host')
    }
  })

  it('opens the popup on the picked element, placed by its frame', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick() })
    expect(popupOpen()).toBe(true)
    expect(slot('element').textContent).toBe('button.save')
    expect(slot('element').title).toBe('body > main > button.save')
    expect(slot('delete').hidden).toBe(true)
    // Under the element: its bottom edge plus the gap.
    expect(popup().style.left).toBe('100px')
    expect(popup().style.top).toBe('78px')
    // The element being written about is framed, unnumbered.
    expect(lastMarks()).toEqual([{ key: 'doc1-1', selector: 'body > main > button.save' }])

    fromFrame({ type: 'rects', rects: [{ key: 'doc1-1', x: 300, y: 200, width: 80, height: 20 }] })
    expect(popup().style.left).toBe('300px')
    expect(popup().style.top).toBe('228px')
  })

  it('ignores a pick while Comment is off, and takes the frame it drew away', async () => {
    await start()
    fromFrame({ type: 'picked', element: pick() })
    expect(popupOpen()).toBe(false)
    expect(lastMarks()).toEqual([])
  })

  it('saves a picked element without an address or an asset, and numbers its frame', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick('doc1-7', { components: ['Button', 'Form'], source: 'src/ui/button.tsx:14' }) })
    type('  too grey  ')
    answers.push({ status: 201, body: { comment: stored('c1', 'too grey') } })
    await save()

    expect(lastWrite()).toMatchObject({ url: '/__cezar_share__/comments', method: 'POST', credentials: 'same-origin' })
    expect(lastWrite().headers['content-type']).toBe('application/json')
    expect(lastWrite().body).toEqual({
      selector: 'body > main > button.save',
      label: 'Save',
      excerpt: '<button class="save">Save</button>',
      component: 'Form › Button (src/ui/button.tsx:14)',
      body: 'too grey',
    })
    // Saved: the popup closes and the frame the pick was drawn under stays, numbered.
    expect(popupOpen()).toBe(false)
    expect(count()).toBe('1')
    expect(lastMarks()).toEqual([{ key: 'doc1-7', n: 1, selector: 'body > main > button.save' }])
  })

  it('caps what the frame reported before it is sent', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick('doc1-1', { text: 'x'.repeat(500), html: 'y'.repeat(5000), selector: `a${' > b'.repeat(400)}` }) })
    type('words')
    answers.push({ status: 201, body: { comment: stored('c1', 'words') } })
    await save()
    const body = lastWrite().body as { label: string; excerpt: string; selector: string }
    expect(body.label).toHaveLength(80)
    expect(body.excerpt).toHaveLength(600)
    expect(body.selector).toHaveLength(1000)
  })

  it('keeps the typed text when the share has ended', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick() })
    type('still here')
    answers.push({ status: 404, body: { error: 'This link is no longer active.' } })
    await save()
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('still here')
    expect(popupMessage()).toBe(ENDED)
    expect(count()).toBe('0')
  })

  it.each([
    [{ status: 409, body: { error: "The reviewer's inbox is full." } } as Answer, "The reviewer's inbox is full."],
    [{ status: 429, body: { error: 'Too many changes at once. Try again in a minute.' } } as Answer, 'Too many changes at once. Try again in a minute.'],
    [{ status: 502 } as Answer, 'Your comment could not be saved. Try again.'],
    ['offline' as Answer, 'Your comment could not be saved. Try again.'],
  ])('keeps the popup and says why a save failed (%#)', async (answer, message) => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick() })
    type('words')
    answers.push(answer)
    await save()
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('words')
    expect(popupMessage()).toBe(message)
  })

  it('saves with Ctrl+Enter and closes with Esc', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick() })
    expect(key(textarea(), { key: 'Escape' }).defaultPrevented).toBe(true)
    expect(popupOpen()).toBe(false)
    // Still commenting: Esc closed the comment, not the mode.
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(lastMarks()).toEqual([])

    fromFrame({ type: 'picked', element: pick('doc1-2', { selector: 'body > main > h1#title' }) })
    type('bigger')
    answers.push({ status: 201, body: { comment: stored('c2', 'bigger', 'body > main > h1#title') } })
    key(textarea(), { key: 'Enter', ctrlKey: true })
    await settle()
    expect(lastWrite().body).toMatchObject({ body: 'bigger', selector: 'body > main > h1#title' })
    expect(popupOpen()).toBe(false)
  })

  it('edits and deletes a saved comment in place, and keeps the text when the link has ended', async () => {
    await start({ stored: [stored('c1')] })
    toggle().click()
    fromFrame({ type: 'mark-clicked', key: 'c1' })
    expect(popupText()).toBe('old words')
    expect(slot('delete').hidden).toBe(false)

    type('new words')
    answers.push({ status: 200, body: { comment: { ...stored('c1', 'new words'), revision: 2 } } })
    await save()
    expect(lastWrite()).toMatchObject({ url: '/__cezar_share__/comments/c1', method: 'PUT', body: { body: 'new words' } })
    expect(popupOpen()).toBe(false)

    fromFrame({ type: 'mark-clicked', key: 'c1' })
    expect(popupText()).toBe('new words')
    answers.push({ status: 404, body: { error: 'That comment is no longer there.' } })
    slot<HTMLButtonElement>('delete').click()
    await settle()
    expect(lastWrite()).toMatchObject({ url: '/__cezar_share__/comments/c1', method: 'DELETE', body: {} })
    expect(lastWrite().headers['content-type']).toBe('application/json')
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('new words')
    expect(popupMessage()).toBe(ENDED)

    answers.push({ status: 204 })
    slot<HTMLButtonElement>('delete').click()
    await settle()
    expect(popupOpen()).toBe(false)
    expect(lastMarks()).toEqual([])
    expect(count()).toBe('0')
  })

  it('does not swap a comment with unsaved text for another element', async () => {
    await start({ stored: [stored('c1')] })
    toggle().click()
    fromFrame({ type: 'picked', element: pick('doc1-1', { selector: 'body > main > h1#title' }) })
    type('not yet saved')
    fromFrame({ type: 'picked', element: pick('doc1-2', { selector: 'body > main > p' }) })
    fromFrame({ type: 'mark-clicked', key: 'c1' })
    expect(popupText()).toBe('not yet saved')
    expect(slot('element').textContent).toBe('h1#title')
    // The second pick's frame is taken away again: the list the picker obeys does not hold it.
    expect(lastMarks()).toEqual([
      { key: 'c1', n: 1, selector: 'body > main > button.save' },
      { key: 'doc1-1', selector: 'body > main > h1#title' },
    ])
  })

  it('stays in comment mode while a comment holds unsaved text', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick() })
    type('not yet saved')
    toggle().click()
    fromFrame({ type: 'toggle' })
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('not yet saved')

    type('')
    toggle().click()
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(popupOpen()).toBe(false)
    expect(lastMarks()).toEqual([])
  })

  it('leaves comment mode on Esc from the bar and on the picker’s own key', async () => {
    await start()
    toggle().click()
    toggle().focus()
    key(toggle(), { key: 'Escape' })
    expect(toggle().getAttribute('aria-pressed')).toBe('false')

    toggle().click()
    fromFrame({ type: 'toggle' })
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    // Off already: the key does not switch it on.
    fromFrame({ type: 'toggle' })
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })
})

describe('a save in flight', () => {
  /** Every way to close the popup, tried while the answer is still on its way. */
  function tryToClose() {
    key(textarea(), { key: 'Escape' })
    slot<HTMLButtonElement>('cancel').click()
    fromFrame({ type: 'cancel' }) // Esc in the mockup, comment mode on
    toggle().click()
  }

  it('keeps a new comment open until its answer, and shows why it was not saved', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick() })
    type('mid flight')
    const pending = later()
    answers.push(pending.promise)
    key(textarea(), { key: 'Enter', ctrlKey: true })
    expect(slot<HTMLButtonElement>('cancel').disabled).toBe(true)
    tryToClose()
    expect(popupOpen()).toBe(true)
    pending.answer({ status: 404, body: { error: 'This link is no longer active.' } })
    await settle()
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('mid flight')
    expect(popupMessage()).toBe(ENDED)
    expect(slot<HTMLButtonElement>('cancel').disabled).toBe(false)
    expect(writes()).toHaveLength(1)
  })

  it('keeps an edit open until its answer, and shows why it was not saved', async () => {
    await start({ stored: [stored('c1')] })
    toggle().click()
    fromFrame({ type: 'mark-clicked', key: 'c1' })
    type('edited mid flight')
    const pending = later()
    answers.push(pending.promise)
    slot<HTMLButtonElement>('save').click()
    tryToClose()
    expect(popupOpen()).toBe(true)
    pending.answer({ status: 404, body: { error: 'That comment is no longer there.' } })
    await settle()
    expect(lastWrite()).toMatchObject({ method: 'PUT' })
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('edited mid flight')
    expect(popupMessage()).toBe(ENDED)
  })

  it('keeps unsaved text when Esc is pressed in the mockup, and closes an empty comment', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick() })
    type('not yet saved')
    fromFrame({ type: 'cancel' })
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('not yet saved')
    type('')
    fromFrame({ type: 'cancel' })
    expect(popupOpen()).toBe(false)
    // The next Esc in the mockup leaves comment mode.
    fromFrame({ type: 'cancel' })
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('does not lose a comment saved while the list was being read again', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick() })
    type('words')
    // The frame reloads: the list is asked for again, and answers only after the save has.
    const reread = later()
    answers.push(reread.promise)
    fromFrame({ type: 'ready' })
    answers.push({ status: 201, body: { comment: stored('c1', 'words') } })
    await save()
    expect(count()).toBe('1')
    answers.push({ status: 200, body: { comments: [stored('c1', 'words')] } })
    reread.answer({ status: 200, body: { comments: [] } })
    await settle()
    expect(count()).toBe('1')
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(3)
  })
})

describe('messages that are not the frame’s', () => {
  it('ignores a pick, a ready and a frame list from any other window', async () => {
    boot({ stored: [stored('c1')] })
    await settle()
    const other = new JSDOM('<!doctype html><title>elsewhere</title>', { url: 'https://evil.example/' })
    try {
      // The top page itself, another site's window, and a message with no window at all.
      for (const source of [win, other.window, null]) {
        fromFrame({ type: 'ready' }, source)
        toggle().click()
        fromFrame({ type: 'picked', element: pick() }, source)
        fromFrame({ type: 'mark-clicked', key: 'c1' }, source)
        fromFrame({ type: 'rects', rects: [{ key: 'c1', x: 1, y: 2, width: 3, height: 4 }] }, source)
        expect(popupOpen()).toBe(false)
        fromFrame({ type: 'cancel' }, source)
        expect(toggle().getAttribute('aria-pressed')).toBe('true')
        toggle().click()
      }
      // Never "ready", so nothing was ever posted to the frame.
      expect(sent).toHaveLength(0)
      expect(writes()).toHaveLength(0)
    } finally {
      other.window.close()
    }
  })

  it('ignores the frame’s own messages that are not the picker’s', async () => {
    await start()
    toggle().click()
    const event = new win.MessageEvent('message', { data: { source: 'somebody-else', type: 'picked', element: pick() } })
    Object.defineProperty(event, 'source', { value: frameWindow })
    win.dispatchEvent(event)
    for (const data of [null, 'picked', 7, { type: 'picked', element: pick() }]) {
      const bare = new win.MessageEvent('message', { data })
      Object.defineProperty(bare, 'source', { value: frameWindow })
      win.dispatchEvent(bare)
    }
    expect(popupOpen()).toBe(false)
  })

  it('opens nothing for a pick that names no element', async () => {
    await start()
    toggle().click()
    for (const element of [null, 'button', { mark: 'doc1-1' }, { mark: 'doc1-1', selector: '' }, { mark: 7, selector: 'a' }, { selector: 'a' }]) {
      fromFrame({ type: 'picked', element })
      expect(popupOpen()).toBe(false)
    }
  })
})

describe('the frame loads again', () => {
  it('tells the new picker the mode and finds every comment again by its selector', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick('doc1-3') })
    type('words')
    answers.push({ status: 201, body: { comment: stored('c1', 'words') } })
    await save()
    expect(lastMarks()).toEqual([{ key: 'doc1-3', n: 1, selector: 'body > main > button.save' }])

    // A reload: the new document's picker knows neither the mode nor the old key.
    sent = []
    answers.push({ status: 200, body: { comments: [stored('c1', 'words')] } })
    fromFrame({ type: 'ready' })
    expect(told('set-active')).toEqual([{ source: 'cezar-design-host', type: 'set-active', active: true }])
    expect(lastMarks()).toEqual([{ key: 'c1', n: 1, selector: 'body > main > button.save' }])
    await settle()
    expect(count()).toBe('1')
    expect(calls.at(-1)).toMatchObject({ url: '/__cezar_share__/comments', method: 'GET' })
  })

  it('keeps a comment being written, and frames its element again', async () => {
    await start()
    toggle().click()
    fromFrame({ type: 'picked', element: pick('doc1-3') })
    type('half written')
    answers.push({ status: 200, body: { comments: [] } })
    fromFrame({ type: 'ready' })
    await settle()
    expect(popupOpen()).toBe(true)
    expect(popupText()).toBe('half written')
    expect(lastMarks()).toEqual([{ key: 'doc1-3', selector: 'body > main > button.save' }])
  })
})

describe('marks', () => {
  const missing = () => told('set-marks').filter((message) => (message.marks as unknown[]).length === 0)

  it('asks again for a comment whose element is not framed yet, a few times, then stops', async () => {
    await start({ stored: [stored('c1')] })
    toggle().click()
    const before = told('set-marks').length
    for (let poll = 1; poll <= 6; poll += 1) {
      for (const fire of intervals) fire()
      // Dropped, then asked for again: the picker searches for the selector anew.
      expect(told('set-marks')).toHaveLength(before + poll * 2)
    }
    for (let poll = 0; poll < 10; poll += 1) for (const fire of intervals) fire()
    expect(told('set-marks')).toHaveLength(before + 12)

    // A frame moved: the page changed, so it is worth looking again.
    fromFrame({ type: 'rects', rects: [] })
    for (const fire of intervals) fire()
    expect(told('set-marks')).toHaveLength(before + 14)
  })

  it('does not ask again once the picker has framed it, or while Comment is off', async () => {
    await start({ stored: [stored('c1')] })
    for (const fire of intervals) fire()
    expect(told('set-marks')).toHaveLength(1)
    expect(missing()).toHaveLength(1)

    toggle().click()
    fromFrame({ type: 'rects', rects: [{ key: 'c1', x: 10, y: 10, width: 50, height: 20 }] })
    const before = told('set-marks').length
    for (const fire of intervals) fire()
    expect(told('set-marks')).toHaveLength(before)
  })
})
