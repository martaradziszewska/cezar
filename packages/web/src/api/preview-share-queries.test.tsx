import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useLiveShares, usePreviewShare } from './queries'
import { createQueryClient } from './query-client'

/**
 * A failed first read must not hide a live link (spec `.ai/specs/2026-11-26-preview-share-link.md`
 * C7, the second anti-goal): both share queries try again before they give up.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SHARE = { runId: 'r1', target: 'http://localhost:5173', url: 'https://x.trycloudflare.com/__cezar_share__/join/t', startedAt: 'a', expiresAt: 'b', guests: [] }
const LIVE = { shares: [{ projectId: 'p1', runId: 'r1', title: 'Settings', target: 'http://localhost:5173', expiresAt: 'b', waiting: 0 }] }

/** Answers `failures` requests with `failure`, then `body`. */
function server(failures: number, failure: 'offline' | number, body: unknown) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      if (calls.length <= failures) {
        if (failure === 'offline') throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify({ error: 'no' }), { status: failure, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }),
  )
  return calls
}

function mount(hook: () => { data: unknown; isError: boolean }) {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(hook, { wrapper })
}

describe.each([
  ['usePreviewShare', () => usePreviewShare('r1'), { share: SHARE }],
  ['useLiveShares', () => useLiveShares(), LIVE],
] as const)('%s', (_name, hook, body) => {
  it('shows the live link when the first read fails and the next one answers', async () => {
    const calls = server(1, 'offline', body)
    const view = mount(hook)
    await waitFor(() => expect(view.result.current.data).toEqual(body), { timeout: 4_000 })
    expect(calls).toHaveLength(2)
  })

  it('tries twice more, then says it failed', async () => {
    const calls = server(Infinity, 'offline', body)
    const view = mount(hook)
    await waitFor(() => expect(view.result.current.isError).toBe(true), { timeout: 4_000 })
    expect(calls).toHaveLength(3)
  })

  it('does not ask again for an answer the server meant (a 4xx)', async () => {
    const calls = server(Infinity, 404, body)
    const view = mount(hook)
    await waitFor(() => expect(view.result.current.isError).toBe(true), { timeout: 4_000 })
    expect(calls).toHaveLength(1)
  })
})
