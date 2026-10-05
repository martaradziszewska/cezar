import { describe, expect, it } from 'vitest'

import {
  capExcerpt,
  commentsRideWith,
  EXCERPT_MAX,
  formatDiffComments,
  parseDiffComments,
  RANGE_EXCERPT_MAX,
  slashCommandOf,
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
    // Typed text leads because its first character is load-bearing: a registry `/skill` is only
    // expanded when the message STARTS with its slash (`expandRegistrySlashSkillText`).
    expect(withDiffComments('/fix-review please', [A])).toBe(`/fix-review please\n\n${formatDiffComments([A])}`)
  })

  it('lets comments ride plain text and registry skills, never a backend slash command', () => {
    expect(commentsRideWith('please fix', ['fix-review'])).toBe(true)
    expect(commentsRideWith('/fix-review please', ['fix-review'])).toBe(true)
    expect(commentsRideWith('/compact', ['fix-review'])).toBe(false)
    expect(commentsRideWith('  /compact focus on tests', ['fix-review'])).toBe(false)
    // The catalog has not arrived: a slash message keeps its comments rather than risk losing them.
    expect(commentsRideWith('/fix-review', undefined)).toBe(false)
    // Not a command at all: a path, or a slash mid-sentence.
    expect(commentsRideWith('/ is the root', [])).toBe(true)
    expect(commentsRideWith('see a/b', [])).toBe(true)
    expect(slashCommandOf('/compact now')).toBe('compact')
  })

  it('caps the excerpt, so a minified line cannot push the draft past its size cap', () => {
    expect(capExcerpt('  short  ')).toBe('short')
    const long = capExcerpt('x'.repeat(50_000))
    expect(long).toHaveLength(EXCERPT_MAX + 1)
    expect(long.endsWith('…')).toBe(true)
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

  it('formats a range comment with its span and every covered line quoted', () => {
    const range: DiffComment = {
      id: 'r',
      path: 'src/a.ts',
      side: 'new',
      line: 14,
      start: { side: 'new', line: 12 },
      body: 'collapse these',
      excerpt: 'const a = 1\nconst b = 2\nconst c = 3',
    }
    expect(formatDiffComments([range])).toBe(
      [
        'Review comments on the diff:',
        '',
        '- `src/a.ts` lines 12–14:',
        '> const a = 1',
        '> const b = 2',
        '> const c = 3',
        '  collapse these',
      ].join('\n'),
    )
    // A range across removed and added lines names both ends.
    expect(formatDiffComments([{ ...range, start: { side: 'old', line: 11 } }])).toContain(
      '`src/a.ts` removed line 11 – line 14:',
    )
  })

  it('keeps a range across storage, and drops a malformed start rather than the comment', () => {
    const range: DiffComment = { ...A, start: { side: 'new', line: 10 } }
    expect(parseDiffComments(JSON.stringify([range]))).toEqual([range])
    expect(parseDiffComments(JSON.stringify([{ ...A, start: { side: 'left', line: 'x' } }]))).toEqual([A])
  })

  it('sorts a range by where it starts', () => {
    const late: DiffComment = { ...A, id: 'late', line: 5 }
    const range: DiffComment = { ...A, id: 'range', line: 20, start: { side: 'new', line: 2 } }
    expect(formatDiffComments([late, range]).indexOf('lines 2–20')).toBeLessThan(
      formatDiffComments([late, range]).indexOf('line 5:'),
    )
  })

  it('gives a range a longer excerpt cap than a single line', () => {
    expect(capExcerpt('x'.repeat(5000), RANGE_EXCERPT_MAX)).toHaveLength(RANGE_EXCERPT_MAX + 1)
    expect(RANGE_EXCERPT_MAX).toBeGreaterThan(EXCERPT_MAX)
  })
})
