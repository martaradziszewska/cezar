import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewShare, PreviewShareGuest } from '@open-mercato/cezar-api-client'
import { ShareError } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'

import { BrowserView } from './browser-view'
import { ShareControl } from './share-control'

/** The Share control in the Preview toolbar (spec 2026-11-26-preview-share-link). */

const api = vi.hoisted(() => ({
  startPreviewShare: vi.fn(),
  stopPreviewShare: vi.fn(),
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

beforeEach(() => {
  client = createQueryClient()
  capability.previewShare = true
  for (const fn of Object.values(api)) fn.mockReset()
  api.getPreviewShare.mockResolvedValue({ share: null })
  api.getGuestComments.mockResolvedValue({ comments: [] })
  writeClipboard.mockReset().mockResolvedValue(undefined)
  toast.mockReset()
})
afterEach(cleanup)

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
    expect(await screen.findByText('Ana · 4821 wants to join')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(api.decidePreviewShareGuest).toHaveBeenCalledWith('r1', GUEST_ID, 'allow')
    // The answer lands in the cache, so the row moves on without waiting for the frame.
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
    await screen.findByText('Ana · 4821 wants to join')
    const rows = Array.from(document.querySelectorAll('[data-slot="share-guest"]'), (row) => row.textContent)
    expect(rows[0]).toContain('Ana · 4821 wants to join')
    expect(rows[1]).toContain('Ola · 1234 wants to join')
    expect(rows[2]).toContain('Piotr')
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
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(false)
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

  it('returns to Share when the server no longer knows the share', async () => {
    seed(liveShare({ guests: [guest()] }))
    renderControl()
    fireEvent.click(liveButton())
    expect(await screen.findByText('Ana · 4821 wants to join')).toBeTruthy()
    // Review Focus 4: the query answers { share: null } after having answered a live one.
    act(() => {
      client.setQueryData(queryKeys.runs.previewShare('r1'), { share: null })
    })
    // The cache notifies on its own tick, so the switch is awaited rather than read at once.
    expect(await screen.findByRole('button', { name: 'Share' })).toBeTruthy()
    expect(screen.queryByText('Ana · 4821 wants to join')).toBeNull()
    expect(screen.queryByText(/Traffic passes through Cloudflare/)).toBeNull()
  })

  it('does not offer a second link on a tab with another origin', async () => {
    seed(liveShare())
    api.stopPreviewShare.mockResolvedValue({ share: null })
    renderControl({ targetOrigin: 'http://localhost:3000' })
    expect(liveButton().textContent).toContain('Sharing localhost:5173')
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
    fireEvent.click(liveButton())
    expect(screen.queryByRole('button', { name: 'Create link' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }))
    expect(api.stopPreviewShare).toHaveBeenCalledWith('r1')
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
    fireEvent.click(liveButton())
    expect((await screen.findByRole('button', { name: 'Stop sharing' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('Ana · 4821 wants to join')).toBeTruthy()
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
