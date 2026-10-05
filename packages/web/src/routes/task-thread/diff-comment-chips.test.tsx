import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DiffCommentChips } from './diff-comment-chips'
import type { DiffComment } from './diff-comments'

afterEach(cleanup)

const base: DiffComment = { id: 'a', path: 'src/app/page.tsx', side: 'new', line: 11, body: 'note', excerpt: '' }

function renderChips(comments: DiffComment[]) {
  render(
    <MemoryRouter>
      <DiffCommentChips runId="r1" comments={comments} onRemove={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('diff comment chips', () => {
  it('labels one line, a same-side range, and a range across removed and added lines', () => {
    renderChips([
      base,
      { ...base, id: 'b', line: 14, start: { side: 'new', line: 12 } },
      { ...base, id: 'c', line: 30, start: { side: 'old', line: 28 } },
    ])
    expect(screen.getByText('page.tsx +11')).not.toBeNull()
    expect(screen.getByText('page.tsx +12–14')).not.toBeNull()
    expect(screen.getByText('page.tsx −28–+30')).not.toBeNull()
  })

  it('speaks the span in words and never reads the body out', () => {
    renderChips([{ ...base, line: 14, start: { side: 'new', line: 12 }, body: 'x'.repeat(4000) }])
    const link = screen.getByRole('link')
    expect(link.getAttribute('aria-label')).toBe('Comment on src/app/page.tsx lines 12–14')
    expect(screen.getByRole('button', { name: 'Remove comment on page.tsx lines 12–14' })).not.toBeNull()
  })
})
