import { describe, expect, it } from 'vitest'

import {
  capExcerpt,
  EXCERPT_MAX,
  formatDiffComments,
  parseDiffComments,
  withDiffComments,
  type DiffComment,
} from './diff-comments'

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

  it('appends the review after the typed message, and leaves a message without comments alone', () => {
    expect(withDiffComments('also run the tests', [A])).toBe(`also run the tests\n\n${formatDiffComments([A])}`)
    expect(withDiffComments('', [A])).toBe(formatDiffComments([A]))
    expect(withDiffComments('just this', [])).toBe('just this')
  })

  it('caps the excerpt, so a minified line cannot push the draft past its size cap', () => {
    expect(capExcerpt('  short  ')).toBe('short')
    const long = capExcerpt('x'.repeat(50_000))
    expect(long).toHaveLength(EXCERPT_MAX + 1)
    expect(long.endsWith('…')).toBe(true)
  })

  // A registry skill is expanded only when the message STARTS with its slash
  // (`expandRegistrySlashSkillText`), so the review must never be put in front of one.
  it('keeps a /skill message leading, so the skill still expands', () => {
    const sent = withDiffComments('/fix-review please', [A])
    expect(sent.startsWith('/fix-review please\n\n')).toBe(true)
    expect(/^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(sent)?.[1]).toBe('fix-review')
  })

  it('orders old-file line numbers before new-file ones within a path', () => {
    const newSide: DiffComment = { ...B, id: 'n', side: 'new', line: 1 }
    const oldSide: DiffComment = { ...B, id: 'o', side: 'old', line: 9 }
    const review = formatDiffComments([newSide, oldSide])
    expect(review.indexOf('line 9 (removed line)')).toBeLessThan(review.indexOf('line 1:'))
  })

  it('names the old path for a removed line of a renamed file, and keeps it across storage', () => {
    const renamed: DiffComment = { ...B, path: 'src/new-name.ts', oldPath: 'src/old-name.ts' }
    expect(parseDiffComments(JSON.stringify([renamed]))).toEqual([renamed])
    expect(formatDiffComments([renamed])).toContain(
      '`src/old-name.ts` line 3 (removed line, renamed to `src/new-name.ts`):',
    )
  })
})
