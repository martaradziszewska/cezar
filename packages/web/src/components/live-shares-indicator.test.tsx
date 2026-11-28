import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveSharesResponse } from '@open-mercato/cezar-api-client'
import { ApiError } from '@/api/client'
import { workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'

import { LiveSharesIndicator, TaskShareBadge } from './live-shares-indicator'

/** The live-link indicators outside the Assets tab (spec 2026-11-28-asset-share-link, C7). */

const api = vi.hoisted(() => ({ stopAssetShare: vi.fn(), getLiveShares: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))

const capability = vi.hoisted(() => ({ assetShare: true }))
vi.mock('@/api/queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHealth: () => ({ data: { capabilities: { assetShare: capability.assetShare } } }),
}))

const toast = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', async (importOriginal) => ({ ...(await importOriginal<object>()), toast }))

type Listed = LiveSharesResponse['shares'][number]
const listed = (overrides: Partial<Listed> = {}): Listed => ({
  projectId: 'cezar',
  runId: 'r1',
  title: 'Brand the Save button',
  asset: 'mockups/settings.html',
  assetTitle: 'Settings mockup',
  expiresAt: '2026-11-27T18:40:00.000Z',
  waiting: 0,
  ...overrides,
})

let client: QueryClient

function seed(shares: Listed[]) {
  client.setQueryData<LiveSharesResponse>(workspaceQueryKeys.liveShares, { shares })
}

function renderWith(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/p/cezar/tasks']}>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const indicator = () => document.querySelector('[data-slot="live-shares"]')
const badge = () => document.querySelector('[data-slot="task-share-badge"]')

beforeEach(() => {
  client = createQueryClient()
  capability.assetShare = true
  api.stopAssetShare.mockReset()
  api.getLiveShares.mockReset().mockResolvedValue({ shares: [] })
  toast.mockReset()
})
afterEach(cleanup)

describe('LiveSharesIndicator', () => {
  it('renders nothing without a live share', async () => {
    renderWith(<LiveSharesIndicator />)
    await waitFor(() => expect(api.getLiveShares).toHaveBeenCalled())
    await waitFor(() => expect(client.getQueryState(workspaceQueryKeys.liveShares)?.status).toBe('success'))
    expect(indicator()).toBeNull()
  })

  it('counts the links and the people waiting', () => {
    seed([listed(), listed({ projectId: 'other', runId: 'r2', waiting: 1 })])
    renderWith(<LiveSharesIndicator />)
    expect(screen.getByRole('button', { name: /live links/ }).textContent).toBe('2 live links · 1 waiting')
  })

  it('says one link in the singular and leaves out an empty queue', () => {
    seed([listed()])
    renderWith(<LiveSharesIndicator />)
    expect(screen.getByRole('button', { name: /live link/ }).textContent).toBe('1 live link')
  })

  it('stays visible while sharing is off, so a live link can still be stopped', () => {
    capability.assetShare = false
    seed([listed()])
    renderWith(<LiveSharesIndicator />)
    expect(indicator()).not.toBeNull()
  })

  it('lists each share with Open onto its asset, on the share’s own project', () => {
    seed([listed(), listed({ projectId: 'other', runId: 'r2', title: '', asset: 'plain.html', assetTitle: '' })])
    renderWith(<LiveSharesIndicator />)
    fireEvent.click(screen.getByRole('button', { name: /live links/ }))
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="live-share"]'))
    expect(items.map((item) => item.querySelector('[data-slot="live-share-title"]')?.textContent)).toEqual([
      'Brand the Save button',
      // No task title yet: what is shared stands in, and an untitled page goes by its file name.
      'plain.html',
    ])
    expect(items.map((item) => item.querySelector('[data-slot="live-share-asset"]')?.textContent)).toEqual(['Settings mockup', 'plain.html'])
    const opens = screen.getAllByRole('link', { name: 'Open' })
    expect(opens.map((link) => link.getAttribute('href'))).toEqual(['/p/cezar/tasks/r1/assets/mockups%2Fsettings.html', '/p/other/tasks/r2/assets/plain.html'])
  })

  it('closes the list when Open is clicked: the asset it opens is not covered by it', async () => {
    seed([listed(), listed({ projectId: 'other', runId: 'r2' })])
    renderWith(<LiveSharesIndicator />)
    fireEvent.click(screen.getByRole('button', { name: /live links/ }))
    expect(screen.getByRole('list', { name: 'Live links' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('link', { name: 'Open' })[1]!)
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Live links' })).toBeNull())
    // The bar itself stays: the links are still live.
    expect(indicator()).not.toBeNull()
    // And it opens again.
    fireEvent.click(screen.getByRole('button', { name: /live links/ }))
    expect(screen.getByRole('list', { name: 'Live links' })).toBeTruthy()
  })

  it('Stop sharing stops that run’s share in its own project', async () => {
    seed([listed(), listed({ projectId: 'other', runId: 'r2' })])
    api.stopAssetShare.mockResolvedValue({ share: null })
    renderWith(<LiveSharesIndicator />)
    fireEvent.click(screen.getByRole('button', { name: /live links/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop sharing' })[1]!)
    await waitFor(() => expect(api.stopAssetShare).toHaveBeenCalledWith('r2', 'other'))
    expect(api.stopAssetShare).toHaveBeenCalledTimes(1)
    expect(toast).not.toHaveBeenCalled()
  })

  it('toasts the server’s message when a stop fails', async () => {
    seed([listed()])
    api.stopAssetShare.mockRejectedValue(new ApiError(404, 'no such run'))
    renderWith(<LiveSharesIndicator />)
    fireEvent.click(screen.getByRole('button', { name: /live link/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('no such run', expect.objectContaining({ tone: 'danger' })))
  })
})

describe('TaskShareBadge', () => {
  it('shows only on the row of a run in the listing, in the same project', () => {
    seed([listed()])
    const view = renderWith(<TaskShareBadge runId="r1" projectId="cezar" />)
    expect(badge()?.textContent).toBe('Sharing')
    view.unmount()

    renderWith(<TaskShareBadge runId="r2" projectId="cezar" />)
    expect(badge()).toBeNull()
    cleanup()

    // The same run id in another project is another task.
    renderWith(<TaskShareBadge runId="r1" projectId="other" />)
    expect(badge()).toBeNull()
  })

  it('renders nothing while the listing loads or after it failed', async () => {
    api.getLiveShares.mockReturnValue(new Promise(() => {}))
    renderWith(<TaskShareBadge runId="r1" projectId="cezar" />)
    expect(badge()).toBeNull()
    cleanup()

    client = createQueryClient()
    // A 4xx: the listing is not asked again, so this is the failed state at once.
    api.getLiveShares.mockRejectedValue(new ApiError(403, 'forbidden'))
    renderWith(<TaskShareBadge runId="r1" projectId="cezar" />)
    await waitFor(() => expect(client.getQueryState(workspaceQueryKeys.liveShares)?.status).toBe('error'))
    expect(badge()).toBeNull()
  })
})
