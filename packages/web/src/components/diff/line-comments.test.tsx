import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Diff } from './diff'
import type { DiffFileChange, DiffLineComment } from './types'

afterEach(cleanup)

const MODIFIED: DiffFileChange = {
  path: 'src/a.ts',
  status: 'modified',
  adds: 1,
  dels: 1,
  patch: [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,3 +3,3 @@',
    ' const one = 1',
    '-const two = 2',
    '+const two = 3',
    ' const three = 3',
    '',
  ].join('\n'),
}

async function renderDiff(ui: React.ReactElement) {
  const view = render(ui)
  await screen.findByText('src/a.ts')
  return view
}

describe('Diff line comments', () => {
  it('offers no "+" when the host takes no comments', async () => {
    await renderDiff(<Diff files={[MODIFIED]} />)
    expect(document.querySelector('[data-slot="diff-add-comment"]')).toBeNull()
  })

  it('opens an editor under the line and hands back anchor, excerpt and body', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    // The added line is new-side line 4.
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 4' }))
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveProperty('disabled', true)

    fireEvent.change(editor, { target: { value: 'why 3?' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledWith({
      path: 'src/a.ts',
      side: 'new',
      line: 4,
      excerpt: 'const two = 3',
      body: 'why 3?',
    })
    expect(screen.queryByPlaceholderText('Add a comment for the AI')).toBeNull()
  })

  it('anchors a deleted line on the old side and Escape cancels without calling back', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on removed line 4' }))
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'x' } })
    fireEvent.keyDown(editor, { key: 'Escape' })

    expect(onAddComment).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('Add a comment for the AI')).toBeNull()
  })

  it('renders saved comments under their line in both layouts, and deletes one', async () => {
    const comments: DiffLineComment[] = [{ id: 'c1', path: 'src/a.ts', side: 'new', line: 5, body: 'nice' }]
    const onRemoveComment = vi.fn()
    const { rerender } = await renderDiff(
      <Diff files={[MODIFIED]} comments={comments} onRemoveComment={onRemoveComment} />,
    )

    const thread = document.querySelector('[data-slot="diff-line-comments"]')!
    expect(thread.textContent).toContain('nice')
    // Directly after the context line it anchors to (new-side 5 = `const three = 3`).
    expect(thread.previousElementSibling?.textContent).toContain('const three = 3')

    rerender(<Diff files={[MODIFIED]} mode="split" comments={comments} onRemoveComment={onRemoveComment} />)
    // A context row maps both cells to one anchor — the comment shows once, not twice.
    expect(document.querySelectorAll('[data-slot="diff-line-comment"]')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }))
    expect(onRemoveComment).toHaveBeenCalledWith('c1')
  })
})
