import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

import { useDiffComments, type DiffComment } from './diff-comments'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const C1: DiffComment = { id: 'c1', path: 'src/a.ts', side: 'new', line: 3, body: 'one', excerpt: '' }
const C2: DiffComment = { id: 'c2', path: 'src/a.ts', side: 'new', line: 9, body: 'two', excerpt: '' }

/** A server that ALWAYS answers the listing with the original comments — as a refetch answered
 *  before the clearing write would. Records every PUT. */
function stubServer(stored: DiffComment[]) {
  const puts: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      if ((init.method ?? 'GET') === 'PUT') {
        puts.push((JSON.parse(String(init.body)) as { text: string }).text)
        return json({ text: '', images: [], updatedAt: '2026-10-05T00:00:00.000Z' })
      }
      if (path === '/api/v1/runs/r1/drafts') {
        return json({
          surfaces: { 'diff-comments': { text: JSON.stringify(stored), images: [], updatedAt: '2026-10-05T00:00:00.000Z' } },
        })
      }
      return json({})
    }),
  )
  return puts
}

function twoHosts() {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const changes = renderHook(() => useDiffComments('r1'), { wrapper })
  return { client, wrapper, changes }
}

describe('diff comments shared across hosts', () => {
  /** The tab switched to mid-send must see the send's outcome — not the list as it was when it
   *  mounted, and not a refetch's pre-clear copy. */
  it('a host mounted while a send is in flight sees the sent comments go', async () => {
    stubServer([C1, C2])
    const { wrapper, changes } = twoHosts()
    await waitFor(() => expect(changes.result.current.comments).toHaveLength(2))

    let land: (value: string) => void = () => {}
    let sending!: Promise<string>
    act(() => {
      sending = changes.result.current.submit(() => new Promise<string>((resolve) => (land = resolve)))
    })
    // The user jumps to the Session tab: a second host mounts while the send is in flight.
    changes.unmount()
    const session = renderHook(() => useDiffComments('r1'), { wrapper })
    expect(session.result.current.comments).toHaveLength(2)

    await act(async () => {
      land('delivered')
      await sending
    })
    expect(session.result.current.comments).toEqual([])
  })

  it('keeps a comment added, or edited, while the send was in flight', async () => {
    const puts = stubServer([C1, C2])
    const { changes } = twoHosts()
    await waitFor(() => expect(changes.result.current.comments).toHaveLength(2))

    let land: (value: string) => void = () => {}
    let sending!: Promise<string>
    act(() => {
      sending = changes.result.current.submit(() => new Promise<string>((resolve) => (land = resolve)))
    })
    act(() => {
      changes.result.current.add({ path: 'src/b.ts', side: 'new', line: 1, excerpt: 'x', body: 'added meanwhile' })
      changes.result.current.update('c2', 'two, edited after it went')
    })

    await act(async () => {
      land('delivered')
      await sending
    })
    // c1 went as it was sent; c2 changed after it was captured; the new one was never sent.
    expect(changes.result.current.comments.map((c) => c.body)).toEqual(['two, edited after it went', 'added meanwhile'])
    await waitFor(() => expect(JSON.parse(puts.at(-1)!).map((c: DiffComment) => c.body)).toEqual(['two, edited after it went', 'added meanwhile']))
  })

  it('a failed send keeps every comment', async () => {
    stubServer([C1, C2])
    const { changes } = twoHosts()
    await waitFor(() => expect(changes.result.current.comments).toHaveLength(2))

    await act(async () => {
      await changes.result.current.submit(() => Promise.reject(new Error('no'))).catch(() => {})
    })
    expect(changes.result.current.comments.map((c) => c.id)).toEqual(['c1', 'c2'])
  })
})
