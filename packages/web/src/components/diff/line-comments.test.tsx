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

async function renderDiff(ui: React.ReactElement, settleText = 'src/a.ts') {
  const view = render(ui)
  await screen.findByText(settleText)
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

    // No `onEditComment` ⇒ no Edit; removal is still offered.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove from chat' }))
    expect(onRemoveComment).toHaveBeenCalledWith('c1')
  })

  it('edits a saved comment in its place, and Cancel leaves it untouched', async () => {
    const comments: DiffLineComment[] = [{ id: 'c1', path: 'src/a.ts', side: 'new', line: 4, body: 'remove this' }]
    const onEditComment = vi.fn()
    const onAddComment = vi.fn()
    await renderDiff(
      <Diff files={[MODIFIED]} comments={comments} onEditComment={onEditComment} onAddComment={onAddComment} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // The comment is swapped for its editor, prefilled.
    expect(document.querySelector('[data-slot="diff-line-comment"]')).toBeNull()
    expect(screen.getByDisplayValue('remove this')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.querySelector('[data-slot="diff-line-comment"]')?.textContent).toContain('remove this')
    expect(onEditComment).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = screen.getByDisplayValue('remove this')
    fireEvent.change(editor, { target: { value: 'remove this import' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onEditComment).toHaveBeenCalledWith('c1', 'remove this import')
    expect(onAddComment).not.toHaveBeenCalled()
  })

  it('anchors a split context row to the new side from EITHER cell', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} mode="split" onAddComment={onAddComment} />)

    // The first context line (`const one = 1`) is old 3 / new 3; click the LEFT (old) cell's "+".
    const pair = [...document.querySelectorAll('[data-slot="diff-pair"]')].find((row) =>
      row.textContent?.includes('const one = 1'),
    )!
    const [leftCell] = pair.querySelectorAll('[data-slot="diff-cell"]')
    fireEvent.click(leftCell!.querySelector('[data-slot="diff-add-comment"]')!)
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'ctx' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({ side: 'new', line: 3, excerpt: 'const one = 1' }))
  })

  it('keeps the editor and its text open when the host refuses the comment', async () => {
    const onAddComment = vi.fn(() => false)
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 4' }))
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'too much' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledTimes(1)
    expect((screen.getByPlaceholderText('Add a comment for the AI') as HTMLTextAreaElement).value).toBe('too much')
  })

  it('carries the pre-rename path with a removed line of a renamed file', async () => {
    const onAddComment = vi.fn()
    const renamed: DiffFileChange = { ...MODIFIED, path: 'src/b.ts', oldPath: 'src/a.ts', status: 'renamed' }
    render(<Diff files={[renamed]} onAddComment={onAddComment} />)
    await screen.findByText('src/b.ts')

    fireEvent.click(screen.getByRole('button', { name: 'Comment on removed line 4' }))
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'why?' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onAddComment).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/b.ts', oldPath: 'src/a.ts', side: 'old', line: 4 }),
    )

    // An added line of the same file carries no oldPath — its number is the new file's.
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 4' }))
    const next = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(next, { target: { value: 'ok' } })
    fireEvent.keyDown(next, { key: 'Enter' })
    expect(onAddComment.mock.calls[1]?.[0]).not.toHaveProperty('oldPath')
  })

  it('anchors a split context row on the new side, whichever cell the "+" was on', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} mode="split" onAddComment={onAddComment} />)

    // The first context row: old 3 | new 3. Its LEFT cell's "+" must still mean new-side 3.
    const pair = document.querySelector('[data-slot="diff-pair"]')!
    const [left] = pair.querySelectorAll<HTMLButtonElement>('[data-slot="diff-add-comment"]')
    fireEvent.click(left!)
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'ctx' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({ side: 'new', line: 3, excerpt: 'const one = 1' }))
  })

  it('keeps the editor and its text open when the host refuses the comment', async () => {
    const onAddComment = vi.fn(() => false)
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 4' }))
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'not kept' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledTimes(1)
    expect(screen.getByDisplayValue('not kept')).not.toBeNull()
  })

  it('hands back the pre-rename path for a removed line of a renamed file', async () => {
    const renamed: DiffFileChange = { ...MODIFIED, path: 'src/b.ts', oldPath: 'src/a.ts', status: 'renamed' }
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[renamed]} onAddComment={onAddComment} />, 'src/b.ts')

    fireEvent.click(screen.getByRole('button', { name: 'Comment on removed line 4' }))
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'gone?' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/b.ts', oldPath: 'src/a.ts', side: 'old', line: 4 }),
    )
  })
})

