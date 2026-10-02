import { describe, expect, it } from 'vitest'

import { formatDiffComments, parseDiffComments, withDiffComments, type DiffComment } from './diff-comments'

const A: DiffComment = { id: 'a', path: 'src/b.ts', side: 'new', line: 12, body: 'rename this', excerpt: '  const x = 1' }
const B: DiffComment = { id: 'b', path: 'src/a.ts', side: 'old', line: 3, body: 'why remove?\nit was used', excerpt: '' }

describe('diff comments', () => {
  it('round-trips through the stored JSON and drops anything malformed', () => {
    const stored = JSON.stringify([A, { id: 'x', path: 'p', side: 'left', line: 1, body: 'b' }, null, 'junk', B])
    expect(parseDiffComments(stored)).toEqual([A, B])
  })

  it('reads an empty, non-JSON or non-array text as no comments', () => {
    expect(parseDiffComments('')).toEqual([])
    expect(parseDiffComments('not json')).toEqual([])
    expect(parseDiffComments('{"id":"a"}')).toEqual([])
  })

  it('formats one review block, ordered by path then line, anchored to file and line', () => {
    expect(formatDiffComments([A, B])).toBe(
      [
        'Review comments on the diff:',
        '',
        '- `src/a.ts` line 3 (removed line):',
        '  why remove?',
        '  it was used',
        '',
        '- `src/b.ts` line 12:',
        '> const x = 1',
        '  rename this',
      ].join('\n'),
    )
  })

  it('puts the review ahead of the typed message, and leaves a message without comments alone', () => {
    expect(withDiffComments('also run the tests', [A])).toBe(`${formatDiffComments([A])}\n\nalso run the tests`)
    expect(withDiffComments('', [A])).toBe(formatDiffComments([A]))
    expect(withDiffComments('just this', [])).toBe('just this')
  })
})
