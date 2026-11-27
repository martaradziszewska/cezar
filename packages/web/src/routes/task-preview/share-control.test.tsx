import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewShare, PreviewShareGuest } from '@open-mercato/cezar-api-client'
import { ApiError, ShareError } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'

import { BrowserView } from './browser-view'
import { ShareControl } from './share-control'

/** The Share control in the Preview toolbar (spec 2026-11-26-preview-share-link). */

const api = vi.hoisted(() => ({
  startPreviewShare: vi.fn(),
  stopPreviewShare: vi.fn(),
  extendPreviewShare: vi.fn(),
  decidePreviewShareGuest: vi.fn(),
  removePreviewShareGuest: vi.fn(),
  getPreviewShare: vi.fn(),
  getGuestComments: vi.fn(),
}))
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))

const capability = vi.hoisted(() => ({ previewShare: true as boolean | undefined }))
vi.mock('@/api/queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHealth: () => ({
    data: capability.previewShare === undefined ? undefined : { capabilities: { previewShare: capability.previewShare } },
  }),
}))

const writeClipboard = vi.hoisted(() => vi.fn())
vi.mock('@/lib/clipboard', () => ({ writeClipboard }))

const toast = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', async (importOriginal) => ({ ...(await importOriginal<object>()), toast }))

const TARGET = 'http://localhost:5173'
const SECRET_URL = 'https://quiet-fox.trycloudflare.com/__cezar_share__/join/SECRET-TOKEN?next=%2Fsettings'
const GUEST_ID = 'a1b2c3d4e5f60718'

const guest = (overrides: Partial<PreviewShareGuest> = {}): PreviewShareGuest => ({
  id: GUEST_ID,
  name: 'Ana',
  code: '4821',
  state: 'waiting',
  requestedAt: '2026-11-27T10:00:00.000Z',
  ...overrides,
})

const liveShare = (overrides: Partial<PreviewShare> = {}): PreviewShare => ({
  runId: 'r1',
  target: TARGET,
  url: SECRET_URL,
  startedAt: '2026-11-27T10:00:00.000Z',
  expiresAt: '2026-11-27T18:40:00.000Z',
  guests: [],
  ...overrides,
})

let client: QueryClient

function seed(share: PreviewShare | null, comments = 0) {
  client.setQueryData(queryKeys.runs.previewShare('r1'), { share })
  client.setQueryData(queryKeys.runs.guestComments('r1'), {
    comments: Array.from({ length: comments }, (_, index) => ({ id: `c${index}` })),
  })
}

function renderControl(props: { targetOrigin?: string | null; path?: string } = {}) {
  return render(
    <QueryClientProvider client={client}>
      <ShareControl runId="r1" targetOrigin={props.targetOrigin === undefined ? TARGET : props.targetOrigin} path={props.path ?? '/settings'} />
    </QueryClientProvider>,
  )
}

const until = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
const liveButton = () => screen.getByRole('button', { name: /Sharing/ })
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="share-guest"]'))
/** The row's text without its buttons: the name element and the code line beside it. */
const label = (row: HTMLElement) => row.querySelector('[data-slot="share-guest-label"]')!.textContent
const labelled = async (text: string) => waitFor(() => expect(rows().map(label)).toContain(text))

beforeEach(() => {
  client = createQueryClient()
  capability.previewShare = true
  for (const fn of Object.values(api)) fn.mockReset()
  api.getPreviewShare.mockResolvedValue({ share: null })
  api.getGuestComments.mockResolvedValue({ comments: [] })
  writeClipboard.mockReset().mockResolvedValue(undefined)
  toast.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ShareControl', () => {
  it('shows the exposure text every time before creating a link', async () => {
    seed(null)
    api.startPreviewShare.mockResolvedValue({ share: liveShare() })
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    const confirm = await screen.findByText(
      /Anyone with this link can use this app and read whatever your dev server serves, including source files\. Traffic passes through Cloudflare\./,
    )
    expect(confirm).toBeTruthy()
    expect(api.startPreviewShare).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    expect(api.startPreviewShare).toHaveBeenCalledWith('r1', { target: 'http://localhost:5173/settings', parentOrigin: window.location.origin })
    await waitFor(() => expect(liveButton()).toBeTruthy())
    expect(writeClipboard).toHaveBeenCalledWith(SECRET_URL)
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Link copied'))

    // Stopping and sharing again asks again: nothing was remembered (C8).
    api.stopPreviewShare.mockResolvedValue({ share: null })
    fireEvent.click(liveButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(await screen.findByText(/Traffic passes through Cloudflare\./)).toBeTruthy()
  })

  it('sends one request for a double click on Create link and says it is working', async () => {
    seed(null)
    let finish: (value: unknown) => void = () => {}
    api.startPreviewShare.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    const create = await screen.findByRole('button', { name: 'Create link' })
    fireEvent.click(create)
    fireEvent.click(create)
    expect(api.startPreviewShare).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Creating link…' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ share: liveShare() }))
    await waitFor(() => expect(liveButton()).toBeTruthy())
  })

  it('keeps the share live when the clipboard refuses the link', async () => {
    seed(null)
    api.startPreviewShare.mockResolvedValue({ share: liveShare() })
    writeClipboard.mockRejectedValue(new Error('denied'))
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Link ready — use Copy link'))
    expect(liveButton()).toBeTruthy()
  })

  it('offers the install command and Retry when cloudflared is missing', async () => {
    seed(null)
    api.startPreviewShare.mockRejectedValueOnce(
      new ShareError(409, 'cloudflared is not installed', { code: 'no-tunnel', install: 'brew install cloudflared' }),
    )
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    const missing = await screen.findByText('Sharing needs cloudflared')
    const panel = missing.closest('[data-slot="share-no-tunnel"]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(within(panel).getByText('brew install cloudflared')).toBeTruthy()

    fireEvent.click(within(panel).getByRole('button', { name: 'Copy install command' }))
    expect(writeClipboard).toHaveBeenCalledWith('brew install cloudflared')

    api.startPreviewShare.mockResolvedValueOnce({ share: liveShare() })
    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }))
    expect(api.startPreviewShare).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(liveButton()).toBeTruthy())
  })

  it("shows cloudflared's own line and Retry when the tunnel does not start", async () => {
    seed(null)
    api.startPreviewShare.mockRejectedValueOnce(
      new ShareError(409, 'failed to request quick Tunnel: 429 Too Many Requests', { code: 'tunnel-failed' }),
    )
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    const line = await screen.findByText('failed to request quick Tunnel: 429 Too Many Requests')
    expect(line.closest('[data-slot="share-tunnel-failed"]')).not.toBeNull()
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows any other refusal with Retry instead of failing silently', async () => {
    seed(null)
    api.startPreviewShare.mockRejectedValueOnce(new ShareError(409, 'Four shares are live already — stop one first'))
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    expect(await screen.findByText('Four shares are live already — stop one first')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('is disabled with the reason on a tab that is not a local http:// address', () => {
    seed(null)
    renderControl({ targetOrigin: null })
    const share = screen.getByRole('button', { name: 'Share' })
    expect((share as HTMLButtonElement).disabled).toBe(true)
    expect(share.getAttribute('title')).toBe('Sharing works on local http:// addresses')
  })

  it('reads the comment count and the end time on the live control', () => {
    seed(liveShare(), 3)
    renderControl()
    expect(liveButton().textContent).toContain(`Sharing · 3 comments · until ${until('2026-11-27T18:40:00.000Z')}`)
    cleanup()
    seed(liveShare(), 1)
    renderControl()
    expect(liveButton().textContent).toContain('1 comment ·')
  })

  it('lets a waiting guest in, with the name and code on the row', async () => {
    seed(liveShare({ guests: [guest()] }))
    api.decidePreviewShareGuest.mockResolvedValue({ share: liveShare({ guests: [guest({ state: 'allowed' })] }) })
    renderControl()
    expect(screen.getByRole('img', { name: '1 person waiting to join' })).toBeTruthy()
    fireEvent.click(liveButton())
    await labelled('Ana · 4821 wants to join')
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(api.decidePreviewShareGuest).toHaveBeenCalledWith('r1', GUEST_ID, 'allow')
    // The answer lands in the cache, so the row moves on without waiting for the frame.
    await labelled('Ana — allowed')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy())
    expect(screen.queryByRole('img', { name: /waiting to join/ })).toBeNull()
  })

  it('lists waiting guests before allowed ones and denies on Deny', async () => {
    seed(
      liveShare({
        guests: [
          guest({ id: '1111111111111111', name: 'Piotr', state: 'allowed' }),
          guest(),
          guest({ id: '2222222222222222', name: 'Ola', code: '1234' }),
        ],
      }),
    )
    api.decidePreviewShareGuest.mockResolvedValue({ share: liveShare() })
    renderControl()
    expect(screen.getByRole('img', { name: '2 people waiting to join' })).toBeTruthy()
    fireEvent.click(liveButton())
    await labelled('Ana · 4821 wants to join')
    expect(rows().map(label)).toEqual(['Ana · 4821 wants to join', 'Ola · 1234 wants to join', 'Piotr'])
    fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[0]!)
    expect(api.decidePreviewShareGuest).toHaveBeenCalledWith('r1', GUEST_ID, 'deny')
  })

  it('removes an allowed guest, and toasts a failed decision leaving the row as it was', async () => {
    seed(liveShare({ guests: [guest({ state: 'allowed' })] }))
    api.removePreviewShareGuest.mockRejectedValue(new Error('Not found'))
    renderControl()
    fireEvent.click(liveButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(api.removePreviewShareGuest).toHaveBeenCalledWith('r1', GUEST_ID)
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Not found', expect.objectContaining({ tone: 'danger' })))
    expect(rows().map(label)).toEqual(['Ana'])
    // Enabled again once the settle window (600 ms) has passed.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('copies the link from the menu and never shows it', async () => {
    seed(liveShare({ guests: [guest()] }))
    const { baseElement } = renderControl()
    fireEvent.click(liveButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))
    expect(writeClipboard).toHaveBeenCalledWith(SECRET_URL)
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Link copied'))
    expect(baseElement.innerHTML).not.toContain('SECRET-TOKEN')

    writeClipboard.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Could not copy the link'))
  })

  it('extends the share from the menu and says until when', async () => {
    seed(liveShare({ guests: [guest()] }))
    const later = '2026-11-28T02:41:00.000Z'
    let answer: (value: unknown) => void = () => {}
    api.extendPreviewShare.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { baseElement } = renderControl()
    fireEvent.click(liveButton())
    const extend = await screen.findByRole('button', { name: 'Extend 8 hours' })
    fireEvent.click(extend)
    fireEvent.click(extend)
    expect(api.extendPreviewShare).toHaveBeenCalledTimes(1)
    expect(api.extendPreviewShare).toHaveBeenCalledWith('r1')
    await waitFor(() => expect((extend as HTMLButtonElement).disabled).toBe(true))
    await act(async () => answer({ share: liveShare({ guests: [guest()], expiresAt: later }) }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(`Sharing until ${until(later)}`))
    expect(liveButton().textContent).toContain(`until ${until(later)}`)
    expect((extend as HTMLButtonElement).disabled).toBe(false)
    expect(baseElement.innerHTML).not.toContain('SECRET-TOKEN')
    expect(toast.mock.calls.flat().join(' ')).not.toContain('SECRET-TOKEN')

    api.extendPreviewShare.mockRejectedValue(new Error('This task is not sharing'))
    fireEvent.click(extend)
    await waitFor(() => expect(toast).toHaveBeenCalledWith('This task is not sharing', expect.objectContaining({ tone: 'danger' })))
    expect(liveButton().textContent).toContain(`until ${until(later)}`)
  })

  describe('Stop against an answer that is still on its way', () => {
    const later = '2026-11-28T02:41:00.000Z'
    const opened = async (share: PreviewShare) => {
      seed(share)
      renderControl()
      fireEvent.click(liveButton())
      return {
        extend: (await screen.findByRole('button', { name: 'Extend 8 hours' })) as HTMLButtonElement,
        stop: screen.getByRole('button', { name: 'Stop sharing' }) as HTMLButtonElement,
      }
    }

    it('turns Extend off while Stop is in flight', async () => {
      api.stopPreviewShare.mockReturnValue(new Promise(() => {}))
      const { extend, stop } = await opened(liveShare())
      fireEvent.click(stop)
      await waitFor(() => expect(extend.disabled).toBe(true))
      fireEvent.click(extend)
      expect(api.extendPreviewShare).not.toHaveBeenCalled()
    })

    it('shows Share, and no new end time, when an Extend answers after the stop', async () => {
      let answerExtend: (value: unknown) => void = () => {}
      api.extendPreviewShare.mockReturnValue(new Promise((resolve) => (answerExtend = resolve)))
      api.stopPreviewShare.mockResolvedValue({ share: null })
      const { extend, stop } = await opened(liveShare())
      fireEvent.click(extend)
      // A live link is always stoppable, a pending Extend included.
      expect(stop.disabled).toBe(false)
      fireEvent.click(stop)
      expect(await screen.findByRole('button', { name: 'Share' })).toBeTruthy()

      await act(async () => answerExtend({ share: liveShare({ expiresAt: later }) }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /Sharing/ })).toBeNull()
      expect(client.getQueryData(queryKeys.runs.previewShare('r1'))).toEqual({ share: null })
      expect(toast.mock.calls.flat().filter((arg) => typeof arg === 'string' && arg.startsWith('Sharing until'))).toEqual([])
    })

    it('shows Share when a guest decision answers after the stop', async () => {
      let answerAllow: (value: unknown) => void = () => {}
      api.decidePreviewShareGuest.mockReturnValue(new Promise((resolve) => (answerAllow = resolve)))
      api.stopPreviewShare.mockResolvedValue({ share: null })
      const { stop } = await opened(liveShare({ guests: [guest()] }))
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
      fireEvent.click(stop)
      expect(await screen.findByRole('button', { name: 'Share' })).toBeTruthy()
      await act(async () => answerAllow({ share: liveShare({ guests: [guest({ state: 'allowed' })] }) }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy()
      expect(client.getQueryData(queryKeys.runs.previewShare('r1'))).toEqual({ share: null })
    })

    it('takes later answers again after a Stop that failed', async () => {
      api.stopPreviewShare.mockRejectedValueOnce(new Error('cannot reach the cezar server'))
      api.extendPreviewShare.mockResolvedValue({ share: liveShare({ expiresAt: later }) })
      const { extend, stop } = await opened(liveShare())
      fireEvent.click(stop)
      await waitFor(() => expect(toast).toHaveBeenCalledWith('cannot reach the cezar server', expect.objectContaining({ tone: 'danger' })))
      await waitFor(() => expect(extend.disabled).toBe(false))
      fireEvent.click(extend)
      await waitFor(() => expect(toast).toHaveBeenCalledWith(`Sharing until ${until(later)}`))
      expect(liveButton().textContent).toContain(`until ${until(later)}`)
    })

    it('takes the answers of the next share', async () => {
      api.stopPreviewShare.mockResolvedValue({ share: null })
      api.startPreviewShare.mockResolvedValue({ share: liveShare({ url: `${SECRET_URL}2` }) })
      api.extendPreviewShare.mockResolvedValue({ share: liveShare({ url: `${SECRET_URL}2`, expiresAt: later }) })
      const { stop } = await opened(liveShare())
      fireEvent.click(stop)
      fireEvent.click(await screen.findByRole('button', { name: 'Share' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
      await waitFor(() => expect(liveButton()).toBeTruthy())
      fireEvent.click(liveButton())
      fireEvent.click(await screen.findByRole('button', { name: 'Extend 8 hours' }))
      await waitFor(() => expect(toast).toHaveBeenCalledWith(`Sharing until ${until(later)}`))
    })
  })

  it('offers no Extend when the capability is off', async () => {
    seed(liveShare())
    capability.previewShare = false
    renderControl()
    fireEvent.click(liveButton())
    await screen.findByRole('button', { name: 'Stop sharing' })
    expect(screen.queryByRole('button', { name: 'Extend 8 hours' })).toBeNull()
  })

  it('returns to Share when the server no longer knows the share', async () => {
    seed(liveShare({ guests: [guest()] }))
    renderControl()
    fireEvent.click(liveButton())
    await labelled('Ana · 4821 wants to join')
    // Review Focus 4: the query answers { share: null } after having answered a live one.
    act(() => {
      client.setQueryData(queryKeys.runs.previewShare('r1'), { share: null })
    })
    // The cache notifies on its own tick, so the switch is awaited rather than read at once.
    expect(await screen.findByRole('button', { name: 'Share' })).toBeTruthy()
    expect(rows()).toEqual([])
    expect(screen.queryByText(/Traffic passes through Cloudflare/)).toBeNull()
  })

  it('does not offer a second link on a tab with another origin', async () => {
    seed(liveShare())
    api.stopPreviewShare.mockResolvedValue({ share: null })
    renderControl({ targetOrigin: 'http://localhost:3000' })
    expect(liveButton().textContent).toContain('Sharing localhost:5173')
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
    fireEvent.click(liveButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }))
    expect(api.stopPreviewShare).toHaveBeenCalledWith('r1')
  })

  describe("a stranger's name beside the join code (C12)", () => {
    const open = async (name: string) => {
      seed(liveShare({ guests: [guest({ name })] }))
      renderControl()
      fireEvent.click(liveButton())
      await waitFor(() => expect(rows()).toHaveLength(1))
      const row = rows()[0]!
      return { row, name: row.querySelector('bdi')!, code: row.querySelector<HTMLElement>('[data-slot="share-guest-code"]')! }
    }

    it('truncates a long name on its own and never the code', async () => {
      const long = 'x'.repeat(60)
      const { row, name, code } = await open(long)
      expect(label(row)).toBe(`${long} · 4821 wants to join`)
      expect(name.className).toContain('truncate')
      expect(code).not.toBeNull()
      expect(name.contains(code)).toBe(false)
      expect(code.className).toContain('shrink-0')
      expect(code.className).not.toContain('truncate')
    })

    it('isolates a right-to-left override inside the name', async () => {
      const { name, code } = await open('Ana‮')
      expect(name.tagName).toBe('BDI')
      expect(name.textContent).toBe('Ana‮')
      expect(name.contains(code)).toBe(false)
      expect(code.textContent).toBe(' · 4821 wants to join')
    })

    it('shows the real code even when the name imitates a row', async () => {
      const { code } = await open('Ana · 0000 wants to join')
      expect(code.textContent).toBe(' · 4821 wants to join')
    })

    it('opens the full name from the keyboard', async () => {
      const { name } = await open('x'.repeat(60))
      expect(name.tabIndex).toBe(0)
      act(() => name.focus())
      expect(await screen.findByRole('tooltip')).toBeTruthy()
    })
  })

  describe('a decision holds the rows still (no second press on the next guest)', () => {
    const ana = guest()
    const ola = guest({ id: '2222222222222222', name: 'Ola', code: '1234', requestedAt: '2026-11-27T10:01:00.000Z' })
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    /** A press at the first row's place, whatever row sits there now. */
    const pressFirst = (name: 'Allow' | 'Deny') => {
      const button = within(rows()[0]!).queryByRole('button', { name })
      if (button) fireEvent.click(button)
    }

    async function decideFirst(decision: 'allow' | 'deny', answer: PreviewShare) {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      seed(liveShare({ guests: [ana, ola] }))
      api.decidePreviewShareGuest.mockResolvedValueOnce({ share: answer }).mockResolvedValueOnce({ share: liveShare() })
      renderControl()
      fireEvent.click(liveButton())
      await labelled('Ana · 4821 wants to join')
      const name = decision === 'allow' ? 'Allow' : 'Deny'
      pressFirst(name)
      pressFirst(name)
      await advance(0)
      expect(rows().map(label)[0]).toBe(decision === 'allow' ? 'Ana — allowed' : 'Ana — denied')
      expect(screen.getAllByRole('button', { name }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
      await advance(300)
      pressFirst(name)
      expect(api.decidePreviewShareGuest).toHaveBeenCalledTimes(1)
      expect(api.decidePreviewShareGuest).toHaveBeenCalledWith('r1', GUEST_ID, decision)

      await advance(400)
      expect(rows().map(label)[0]).toBe('Ola · 1234 wants to join')
      const next = within(rows()[0]!).getByRole('button', { name }) as HTMLButtonElement
      expect(next.disabled).toBe(false)
      fireEvent.click(next)
      expect(api.decidePreviewShareGuest).toHaveBeenCalledTimes(2)
      expect(api.decidePreviewShareGuest).toHaveBeenLastCalledWith('r1', ola.id, decision)
    }

    it('after Allow', async () => {
      await decideFirst('allow', liveShare({ guests: [{ ...ana, state: 'allowed' }, ola] }))
      expect(rows().map(label)).toEqual(['Ola · 1234 wants to join', 'Ana'])
    })

    it('after Deny, the denied row leaving only once the window ends', async () => {
      await decideFirst('deny', liveShare({ guests: [ola] }))
      expect(rows().map(label)).toEqual(['Ola · 1234 wants to join'])
    })
  })

  describe('rows that move on their own hold every button still (anyone with the link can add a row)', () => {
    const piotr = guest({ id: '1111111111111111', name: 'Piotr', state: 'allowed', requestedAt: '2026-11-27T09:00:00.000Z' })
    const ana = guest()
    const ola = guest({ id: '2222222222222222', name: 'Ola', code: '1234', requestedAt: '2026-11-27T10:01:00.000Z' })
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    const arrive = async (guests: PreviewShareGuest[], overrides: Partial<PreviewShare> = {}) => {
      act(() => {
        client.setQueryData(queryKeys.runs.previewShare('r1'), { share: liveShare({ guests, ...overrides }) })
      })
      // The cache notifies on its own tick.
      await advance(0)
    }
    const buttons = () => within(screen.getByRole('list', { name: 'People on this link' })).queryAllByRole('button') as HTMLButtonElement[]
    /** A press at the first row's place, on whatever buttons sit there now. */
    const pressFirstRow = () => {
      for (const button of within(rows()[0]!).queryAllByRole('button')) fireEvent.click(button)
    }
    const decided = () => api.decidePreviewShareGuest.mock.calls.length + api.removePreviewShareGuest.mock.calls.length

    async function opened(guests: PreviewShareGuest[]) {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      seed(liveShare({ guests }))
      api.decidePreviewShareGuest.mockResolvedValue({ share: liveShare() })
      api.removePreviewShareGuest.mockResolvedValue({ share: liveShare() })
      renderControl()
      fireEvent.click(liveButton())
      await waitFor(() => expect(rows()).toHaveLength(guests.length))
      expect(buttons().every((button) => !button.disabled)).toBe(true)
    }

    it('when a visitor asks to join: Allow lands where Remove was, and a click there does nothing', async () => {
      await opened([piotr])
      expect(within(rows()[0]!).getByRole('button', { name: 'Remove' })).toBeTruthy()
      await arrive([piotr, ana])
      expect(rows().map(label)).toEqual(['Ana · 4821 wants to join', 'Piotr'])
      expect(buttons().map((button) => button.disabled)).toEqual([true, true, true])
      pressFirstRow()
      await advance(300)
      pressFirstRow()
      expect(decided()).toBe(0)

      await advance(400)
      expect(buttons().map((button) => button.disabled)).toEqual([false, false, false])
      fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Allow' }))
      expect(api.decidePreviewShareGuest).toHaveBeenCalledWith('r1', GUEST_ID, 'allow')
    })

    it('when a waiting request expires and the next one moves up', async () => {
      await opened([ana, ola])
      await arrive([ola])
      expect(rows().map(label)).toEqual(['Ola · 1234 wants to join'])
      pressFirstRow()
      await advance(300)
      pressFirstRow()
      expect(decided()).toBe(0)
      await advance(400)
      expect(buttons().every((button) => !button.disabled)).toBe(true)
    })

    it('when another window lets a visitor in, and the row trades its buttons', async () => {
      await opened([ana])
      await arrive([{ ...ana, state: 'allowed' }])
      expect(buttons().map((button) => [button.textContent, button.disabled])).toEqual([['Remove', true]])
      pressFirstRow()
      expect(decided()).toBe(0)
      await advance(700)
      expect(buttons().map((button) => button.disabled)).toEqual([false])
    })

    it('starts the wait again with every new row', async () => {
      await opened([piotr])
      await arrive([piotr, ana])
      await advance(500)
      await arrive([piotr, ana, ola])
      await advance(300)
      pressFirstRow()
      expect(decided()).toBe(0)
      await advance(400)
      expect(buttons().every((button) => !button.disabled)).toBe(true)
    })

    it('not when only the end time changes', async () => {
      await opened([piotr, ana])
      await arrive([piotr, ana], { expiresAt: '2026-11-28T02:40:00.000Z' })
      expect(buttons().every((button) => !button.disabled)).toBe(true)
    })

    it('when a visitor arrives while a decision holds the rows: the wait starts again as the rows are let go', async () => {
      await opened([ana, ola])
      api.decidePreviewShareGuest.mockResolvedValueOnce({ share: liveShare({ guests: [{ ...ana, state: 'allowed' }, ola] }) })
      fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Allow' }))
      await advance(0)
      const zed = guest({ id: '3333333333333333', name: 'Zed', code: '9999', requestedAt: '2026-11-27T10:02:00.000Z' })
      await arrive([{ ...ana, state: 'allowed' }, ola, zed])
      // Held: the new row waits at the end until the decision's own window is over.
      expect(rows().map(label)).toEqual(['Ana — allowed', 'Ola · 1234 wants to join', 'Zed · 9999 wants to join'])
      await advance(650)
      // Let go: Zed's Allow is now where Ola's was.
      expect(rows().map(label)).toEqual(['Ola · 1234 wants to join', 'Zed · 9999 wants to join', 'Ana'])
      expect(buttons().every((button) => button.disabled)).toBe(true)
      for (const button of buttons()) fireEvent.click(button)
      expect(api.decidePreviewShareGuest).toHaveBeenCalledTimes(1)
      await advance(650)
      expect(buttons().every((button) => !button.disabled)).toBe(true)
    })

    it('a share that ends with a decision still unanswered leaves the next share’s buttons working', async () => {
      await opened([ana])
      api.decidePreviewShareGuest.mockReturnValue(new Promise(() => {}))
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
      expect(api.decidePreviewShareGuest).toHaveBeenCalledTimes(1)
      act(() => {
        client.setQueryData(queryKeys.runs.previewShare('r1'), { share: null })
      })
      await advance(0)
      expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy()

      act(() => {
        client.setQueryData(queryKeys.runs.previewShare('r1'), { share: liveShare({ url: `${SECRET_URL}2` }) })
      })
      await advance(0)
      fireEvent.click(liveButton())
      await arrive([ola], { url: `${SECRET_URL}2` })
      await advance(700)
      expect(rows().map(label)).toEqual(['Ola · 1234 wants to join'])
      expect(buttons().map((button) => button.disabled)).toEqual([false, false])
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
      expect(api.decidePreviewShareGuest).toHaveBeenLastCalledWith('r1', ola.id, 'allow')
    })
  })

  it('toasts a start that fails after the popover closed, and opens on the confirm again', async () => {
    seed(null)
    let fail: (error: unknown) => void = () => {}
    api.startPreviewShare.mockReturnValue(new Promise((_, reject) => (fail = reject)))
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(/Traffic passes through Cloudflare/)).toBeNull())
    await act(async () => fail(new ShareError(409, 'Four shares are live already')))
    expect(toast).toHaveBeenCalledWith('Four shares are live already', expect.objectContaining({ tone: 'danger' }))
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(await screen.findByRole('button', { name: 'Create link' })).toBeTruthy()
    expect(screen.queryByText('Four shares are live already')).toBeNull()
  })

  describe('a failure the server explained is shown, never reported as an error', () => {
    /** A start that fails with the popover closed, so the failure is the toast. */
    async function startFailing(error: unknown) {
      seed(null)
      let fail: (error: unknown) => void = () => {}
      api.startPreviewShare.mockReturnValue(new Promise((_, reject) => (fail = reject)))
      renderControl()
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByText(/Traffic passes through Cloudflare/)).toBeNull())
      await act(async () => fail(error))
    }

    it.each([
      ['a refused start (409)', new ShareError(409, 'Four shares are live already'), true],
      ['a refused target (400)', new ShareError(400, 'The app at http://localhost:5173 is not answering. Start it, then share.'), true],
      ['a missing tunnel binary (409)', new ShareError(409, 'Sharing needs cloudflared', { code: 'no-tunnel', install: 'brew install cloudflared' }), true],
      ['a server that broke (500)', new ShareError(500, 'Internal Server Error'), false],
      ['a request that never arrived', new ShareError(0, 'cannot reach the cezar server'), false],
      ['anything that is not an answer', new Error('boom'), false],
    ])('%s', async (_label, error, expected) => {
      await startFailing(error)
      expect(toast).toHaveBeenCalledWith((error as Error).message, { tone: 'danger', expected })
    })

    it('an Extend the server refused (404), as before', async () => {
      seed(liveShare())
      api.extendPreviewShare.mockRejectedValue(new ApiError(404, 'This task is not sharing'))
      renderControl()
      fireEvent.click(liveButton())
      fireEvent.click(await screen.findByRole('button', { name: 'Extend 8 hours' }))
      await waitFor(() => expect(toast).toHaveBeenCalledWith('This task is not sharing', { tone: 'danger', expected: true }))
    })
  })

  it('disables Create link when the tab leaves a local address with the popover open', async () => {
    seed(null)
    const { rerender } = renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    await screen.findByRole('button', { name: 'Create link' })
    rerender(
      <QueryClientProvider client={client}>
        <ShareControl runId="r1" targetOrigin={null} path="/" />
      </QueryClientProvider>,
    )
    const create = screen.getByRole('button', { name: 'Create link' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    expect(create.getAttribute('title')).toBe('Sharing works on local http:// addresses')
  })

  it('opens the confirm with focus on the panel, not on Create link', async () => {
    seed(null)
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    const create = await screen.findByRole('button', { name: 'Create link' })
    await waitFor(() => expect(document.activeElement?.getAttribute('data-slot')).toBe('popover-content'))
    expect(document.activeElement).not.toBe(create)
  })

  it('keeps the started share when a refetch that began before it answers late', async () => {
    seed(null)
    let late: (value: unknown) => void = () => {}
    api.getPreviewShare.mockReturnValueOnce(new Promise((resolve) => (late = resolve)))
    api.startPreviewShare.mockResolvedValue({ share: liveShare() })
    renderControl()
    void client.refetchQueries({ queryKey: queryKeys.runs.previewShare('r1') })
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    await waitFor(() => expect(liveButton()).toBeTruthy())
    await act(async () => late({ share: null }))
    expect(liveButton()).toBeTruthy()
    expect(client.getQueryData(queryKeys.runs.previewShare('r1'))).toEqual({ share: liveShare() })
  })


  it('renders nothing when the capability is off', () => {
    seed(null)
    capability.previewShare = false
    const { container } = renderControl()
    expect(container.innerHTML).toBe('')
    cleanup()
    capability.previewShare = undefined
    expect(renderControl().container.innerHTML).toBe('')
  })

  it('keeps a live share stoppable when the capability reads off, without guest decisions', async () => {
    seed(liveShare({ guests: [guest()] }))
    capability.previewShare = false
    renderControl()
    // The owner cannot act on a waiting guest here, so nothing calls for attention.
    expect(screen.queryByRole('img', { name: /waiting to join/ })).toBeNull()
    fireEvent.click(liveButton())
    expect((await screen.findByRole('button', { name: 'Stop sharing' }) as HTMLButtonElement).disabled).toBe(false)
    expect(rows().map(label)).toEqual(['Ana · 4821 wants to join'])
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
  })
})

describe('the Preview toolbar', () => {
  const view = (runId?: string) =>
    render(
      <QueryClientProvider client={client}>
        <BrowserView state={{ tabs: ['http://localhost:5173/settings?tab=1#top'], active: 0 }} onChange={vi.fn()} {...(runId ? { runId } : {})} />
      </QueryClientProvider>,
    )

  it("shares the tab's own origin, path and search", async () => {
    seed(null)
    api.startPreviewShare.mockResolvedValue({ share: liveShare() })
    view('r1')
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    expect(api.startPreviewShare).toHaveBeenCalledWith('r1', {
      target: 'http://localhost:5173/settings?tab=1',
      parentOrigin: window.location.origin,
    })
  })

  it('offers no Share without a task', () => {
    seed(null)
    view()
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
  })
})
