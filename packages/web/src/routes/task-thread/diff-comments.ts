import { useCallback, useMemo } from 'react'

import { DRAFT_TEXT_MAX } from '@open-mercato/cezar-api-client'
import { COMMENT_MAX, describeLines, type DiffLineComment, type DiffLineEnd, type DiffNewLineComment } from '@/components/diff'
import { toast } from '@/components/ui/toaster'

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
  /** A removed line of a renamed file: the path its line number belongs to. */
  oldPath?: string
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
      ...(typeof c.oldPath === 'string' && c.oldPath !== '' ? { oldPath: c.oldPath } : {}),
      ...(isLineEnd(c.start) ? { start: { side: c.start.side, line: c.start.line } } : {}),
    })
  }
  return out
}

function isLineEnd(value: unknown): value is DiffLineEnd {
  if (value === null || typeof value !== 'object') return false
  const end = value as Record<string, unknown>
  return (end.side === 'old' || end.side === 'new') && typeof end.line === 'number'
}

/** "line 12", "lines 10–14", "removed line 3 – line 5" — for the agent and for the chips. */
export function linesLabel(comment: Pick<DiffComment, 'side' | 'line' | 'start'>): string {
  return describeLines(comment, comment.start)
}

/** Path, then side (old-file numbers before new-file ones — they count different files), then
 *  line: the order a reviewer reads a diff in, whatever order the notes were left. */
export function sortDiffComments(comments: readonly DiffComment[]): DiffComment[] {
  const side = (c: DiffLineEnd) => (c.side === 'old' ? 0 : 1)
  // A range sorts by where it STARTS — that is where a reader meets it.
  const first = (c: DiffComment) => c.start ?? c
  return [...comments].sort(
    (a, b) => a.path.localeCompare(b.path) || side(first(a)) - side(first(b)) || first(a).line - first(b).line,
  )
}

/** What the agent receives: one review block, every comment anchored to file + line. */
export function formatDiffComments(comments: readonly DiffComment[]): string {
  if (comments.length === 0) return ''
  const blocks = sortDiffComments(comments).map((comment) => {
    // A removed line is numbered in the OLD file, so a renamed file names the old path with it.
    const where =
      comment.side === 'old' ?
        `\`${comment.oldPath ?? comment.path}\` line ${comment.line} (removed line${comment.oldPath ? `, renamed to \`${comment.path}\`` : ''})`
      : `\`${comment.path}\` line ${comment.line}`
    const excerpt = comment.excerpt.trim() === '' ? '' : `\n${quote(comment.excerpt)}`
    return `- ${comment.start ? rangeWhere(comment) : where}:${excerpt}\n${indent(comment.body)}`
  })
  return `Review comments on the diff:\n\n${blocks.join('\n\n')}`
}

/**
 * The message that carries the comments: whatever the user typed, then the review. The typed text
 * leads because its first character is load-bearing — a `/skill` message is only expanded when it
 * STARTS with the slash (`expandRegistrySlashSkillText`), and so are the backends' own commands.
 */
export function withDiffComments(text: string, comments: readonly DiffComment[]): string {
  const review = formatDiffComments(comments)
  if (review === '') return text
  return text.trim() === '' ? review : `${text}\n\n${review}`
}

/** The command a message opens with (`/compact args` → `compact`), or undefined. The same token
 *  rule the server's registry expansion uses (`expandRegistrySlashSkillText`). */
export function slashCommandOf(text: string): string | undefined {
  return /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(text.trimStart())?.[1]
}

/**
 * May the comments ride this message? Not when it opens with a slash command cezar does not know
 * as a registry skill: that is a BACKEND command (`/compact`, `/clear`, …), and anything appended
 * becomes its arguments — the send succeeds, the comments are cleared, and the agent never saw a
 * review. A registry skill is fine: the server expands it and the review stays the request. While
 * the skill list is unknown, a slash message keeps its comments — losing them is the worse error.
 */
export function commentsRideWith(text: string, skillNames: readonly string[] | undefined): boolean {
  const command = slashCommandOf(text)
  return command === undefined || (skillNames?.includes(command) ?? false)
}

/** A range names its span; removed lines in it are numbered in the old file, so a renamed file
 *  says which one. */
function rangeWhere(comment: DiffComment): string {
  const touchesOld = comment.side === 'old' || comment.start?.side === 'old'
  const renamed = comment.oldPath && touchesOld ? ` (removed lines numbered in \`${comment.oldPath}\`)` : ''
  return `\`${comment.path}\` ${linesLabel(comment)}${renamed}`
}

/** Every excerpt line as a Markdown quote line — a range quotes all the code it covers. */
function quote(excerpt: string): string {
  return excerpt
    .trim()
    .split('\n')
    .map((line) => `> ${line.trimEnd()}`)
    .join('\n')
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

/** A range quotes every line it covers, so it gets more room — still bounded, for the same reason. */
export const RANGE_EXCERPT_MAX = 1000

export function capExcerpt(excerpt: string, max: number = EXCERPT_MAX): string {
  const trimmed = excerpt.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface DiffComments {
  /** The stored comments ARRIVED. Until then there is no list to add to: an edit would mark the
   *  draft dirty, the seed would be skipped, and the first write would replace every stored comment
   *  with the one just added. A FAILED read is not ready either, for the same reason — the server
   *  may still hold a list this cockpit never saw. Hosts offer "add" only once ready. */
  ready: boolean
  comments: DiffComment[]
  /** `false` when the comment could not be kept (the list would outgrow the draft cap). */
  add: (comment: DiffNewLineComment) => boolean
  update: (id: string, body: string) => boolean
  remove: (id: string) => void
  clear: () => void
  /** Hand the comments to a send: they are dropped only once it resolves; a failed send keeps them. */
  submit: <T>(action: (comments: DiffComment[]) => Promise<T>) => Promise<T>
}

export function useDiffComments(runId: string): DiffComments {
  const draft = useDraft(runId, DIFF_COMMENTS_SURFACE)
  const comments = useMemo(() => parseDiffComments(draft.text), [draft.text])
  const { setText, clear } = draft

  /** Every write is size-checked HERE: the store refuses an over-cap entry, and a refused draft
   *  write is silent by design — so the comments would look kept and be gone after a reload. */
  const write = useCallback(
    (next: readonly DiffComment[]): boolean => {
      if (next.length === 0) {
        clear()
        return true
      }
      const text = JSON.stringify(next)
      if (text.length > DRAFT_TEXT_MAX) {
        toast('Too many comments to keep as a draft — send the ones you have first.', { tone: 'danger' })
        return false
      }
      setText(text)
      return true
    },
    [clear, setText],
  )
  const add = useCallback(
    (comment: DiffNewLineComment) =>
      write([
        ...comments,
        {
          ...comment,
          body: comment.body.slice(0, COMMENT_MAX),
          excerpt: capExcerpt(comment.excerpt, comment.start ? RANGE_EXCERPT_MAX : EXCERPT_MAX),
          id: newId(),
        },
      ]),
    [comments, write],
  )
  const update = useCallback(
    (id: string, body: string) =>
      write(comments.map((c) => (c.id === id ? { ...c, body: body.slice(0, COMMENT_MAX) } : c))),
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

  return { ready: draft.loaded, comments, add, update, remove, clear, submit }
}
