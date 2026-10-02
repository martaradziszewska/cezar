import { useCallback, useMemo } from 'react'

import type { DiffLineComment, DiffNewLineComment } from '@/components/diff'

import { useDraft } from './thread-draft'

/**
 * Diff line comments — the self-review flow. On the Changes tab the user leaves notes on lines of
 * the task's diff; they are NOT sent one by one. They pile up as draft items in the thread
 * composer (one chip per comment) and ride the next message to the agent as a single review.
 *
 * Stored in the run's server-side draft store under the `diff-comments` surface, as JSON in the
 * entry's `text`, so they survive the route change between Changes and the thread (the whole
 * point), a reload, and another browser — on exactly the terms `useDraft` already gives every
 * other unsent input. The two hosts never mount at once (they are sibling routes), so each one
 * seeding from the shared cache on mount is enough to keep them in step.
 */

export const DIFF_COMMENTS_SURFACE = 'diff-comments'

export interface DiffComment extends DiffLineComment {
  /** The commented line's text when the comment was written. */
  excerpt: string
}

/** Defensive: the stored text is whatever the wire carried. Anything malformed is dropped. */
export function parseDiffComments(text: string): DiffComment[] {
  if (text === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: DiffComment[] = []
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    if (
      typeof c.id !== 'string' ||
      typeof c.path !== 'string' ||
      (c.side !== 'old' && c.side !== 'new') ||
      typeof c.line !== 'number' ||
      typeof c.body !== 'string'
    ) {
      continue
    }
    out.push({
      id: c.id,
      path: c.path,
      side: c.side,
      line: c.line,
      body: c.body,
      excerpt: typeof c.excerpt === 'string' ? c.excerpt : '',
    })
  }
  return out
}

/** Path, then line — the order a reviewer reads a diff in, whatever order the notes were left. */
export function sortDiffComments(comments: readonly DiffComment[]): DiffComment[] {
  return [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
}

/** What the agent receives: one review block, every comment anchored to file + line. */
export function formatDiffComments(comments: readonly DiffComment[]): string {
  if (comments.length === 0) return ''
  const blocks = sortDiffComments(comments).map((comment) => {
    const where = `\`${comment.path}\` line ${comment.line}${comment.side === 'old' ? ' (removed line)' : ''}`
    const excerpt = comment.excerpt.trim() === '' ? '' : `\n> ${comment.excerpt.trim()}`
    return `- ${where}:${excerpt}\n${indent(comment.body)}`
  })
  return `Review comments on the diff:\n\n${blocks.join('\n\n')}`
}

/** The message that carries the comments: the review first, then whatever the user typed. */
export function withDiffComments(text: string, comments: readonly DiffComment[]): string {
  const review = formatDiffComments(comments)
  if (review === '') return text
  return text.trim() === '' ? review : `${review}\n\n${text}`
}

function indent(body: string): string {
  return body
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/** How much of the commented line a comment keeps. A minified line can be the whole file, and
 *  every comment lives in ONE draft entry capped at `DRAFT_TEXT_MAX` — whose rejected write is
 *  silent by design — so an uncapped excerpt could quietly stop the comments from persisting. */
export const EXCERPT_MAX = 200

export function capExcerpt(excerpt: string): string {
  const trimmed = excerpt.trim()
  return trimmed.length <= EXCERPT_MAX ? trimmed : `${trimmed.slice(0, EXCERPT_MAX)}…`
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface DiffComments {
  /** The stored comments have loaded (or failed to). Until then there is no list to add to: an
   *  edit would mark the draft dirty, the seed would then be skipped, and the first write would
   *  replace every stored comment with the one just added. Hosts offer "add" only once ready. */
  ready: boolean
  comments: DiffComment[]
  add: (comment: DiffNewLineComment) => void
  update: (id: string, body: string) => void
  remove: (id: string) => void
  clear: () => void
  /** Hand the comments to a send: they are dropped only once it resolves; a failed send keeps them. */
  submit: <T>(action: (comments: DiffComment[]) => Promise<T>) => Promise<T>
}

export function useDiffComments(runId: string): DiffComments {
  const draft = useDraft(runId, DIFF_COMMENTS_SURFACE)
  const comments = useMemo(() => parseDiffComments(draft.text), [draft.text])
  const { setText, clear } = draft

  const write = useCallback(
    (next: readonly DiffComment[]) => (next.length === 0 ? clear() : setText(JSON.stringify(next))),
    [clear, setText],
  )
  const add = useCallback(
    (comment: DiffNewLineComment) =>
      write([...comments, { ...comment, excerpt: capExcerpt(comment.excerpt), id: newId() }]),
    [comments, write],
  )
  const update = useCallback(
    (id: string, body: string) => write(comments.map((c) => (c.id === id ? { ...c, body } : c))),
    [comments, write],
  )
  const remove = useCallback((id: string) => write(comments.filter((c) => c.id !== id)), [comments, write])

  // Not cleared up front (unlike the composer's optimistic clear): a rejected send must leave
  // every comment exactly where it was, and the chips staying put during the send says so.
  const submit = useCallback(
    async <T>(action: (held: DiffComment[]) => Promise<T>): Promise<T> => {
      const result = await action(comments)
      if (comments.length > 0) clear()
      return result
    },
    [clear, comments],
  )

  return { ready: draft.ready, comments, add, update, remove, clear, submit }
}
