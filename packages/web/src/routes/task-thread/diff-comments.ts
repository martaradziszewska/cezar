import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import { putRunDraft } from '@/api/client'
import { queryKeys, useRunDrafts } from '@/api/queries'
import { DRAFT_TEXT_MAX, type RunDraftsResponse } from '@open-mercato/cezar-api-client'
import { COMMENT_MAX, describeLines, type DiffLineComment, type DiffLineEnd, type DiffNewLineComment } from '@/components/diff'
import { toast } from '@/components/ui/toaster'

/**
 * Diff line comments — the self-review flow. On the Changes tab the user leaves notes on lines of
 * the task's diff; they are NOT sent one by one. They pile up as draft items in the thread
 * composer (one chip per comment) and ride the next message to the agent as a single review.
 *
 * Stored in the run's server-side draft store under the `diff-comments` surface, as JSON in the
 * entry's `text`, so they survive the route change between Changes and the thread (the whole
 * point), a reload, and another browser. See `useDiffComments` for why they are read from the
 * query cache rather than through `useDraft`.
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
  /** The stored comments ARRIVED. Until then there is no list to add to: the first write would
   *  replace whatever the server holds with just the new comment. A FAILED read is not ready
   *  either, for the same reason — the server may still hold a list this cockpit never saw.
   *  Hosts offer "add" only once ready. */
  ready: boolean
  comments: DiffComment[]
  /** `false` when the comment could not be kept (the list would outgrow the draft cap). */
  add: (comment: DiffNewLineComment) => boolean
  update: (id: string, body: string) => boolean
  remove: (id: string) => void
  clear: () => void
  /** Hand the comments to a send. Once it lands, exactly the comments it carried are dropped —
   *  one added, or edited, while it was in flight stays a draft. A failed send keeps them all. */
  submit: <T>(action: (comments: DiffComment[]) => Promise<T>) => Promise<T>
}

/**
 * The comments live in ONE place per run: an in-memory list every host subscribes to, seeded once
 * from the server's draft listing and changed only by the user's own actions. Unlike the text
 * inputs (`useDraft`, which seeds local state once and then owns it), no host keeps a copy — the
 * Changes tab, the Session composer and the review panel can each be the one that adds, sends or
 * clears, and a tab switched to mid-send must see the send's outcome, not the list as it was when
 * the tab mounted.
 *
 * Deliberately NOT read live from the query cache: a send invalidates the run's queries, and a
 * refetch answered before the clearing write landed would put the sent comments straight back.
 * Each write still mirrors into the cache, so a fresh load reads what was written. Keyed by the
 * query client, so every client (and every test) has its own lists.
 */
interface CommentsStore {
  lists: Map<string, DiffComment[]>
  listeners: Map<string, Set<() => void>>
  /** One write chain per run: two quick edits on two tabs still land in order. */
  chains: Map<string, Promise<unknown>>
}
const stores = new WeakMap<object, CommentsStore>()
function storeFor(client: object): CommentsStore {
  let store = stores.get(client)
  if (!store) {
    store = { lists: new Map(), listeners: new Map(), chains: new Map() }
    stores.set(client, store)
  }
  return store
}

const NO_COMMENTS: DiffComment[] = []

export function useDiffComments(runId: string): DiffComments {
  const queryClient = useQueryClient()
  const store = storeFor(queryClient)
  const drafts = useRunDrafts(runId === '' ? undefined : runId)
  const storedText = drafts.data?.surfaces?.[DIFF_COMMENTS_SURFACE]?.text
  const serverComments = useMemo(
    () => parseDiffComments(typeof storedText === 'string' ? storedText : ''),
    [storedText],
  )

  const subscribe = useCallback(
    (listener: () => void) => {
      const set = store.listeners.get(runId) ?? new Set()
      set.add(listener)
      store.listeners.set(runId, set)
      return () => set.delete(listener)
    },
    [runId, store],
  )
  const live = useSyncExternalStore(subscribe, () => store.lists.get(runId))

  // Seed once, from the first listing that arrives. After that the list is the user's alone.
  useEffect(() => {
    if (drafts.isSuccess && !store.lists.has(runId)) {
      store.lists.set(runId, serverComments)
      store.listeners.get(runId)?.forEach((listener) => listener())
    }
  }, [drafts.isSuccess, runId, serverComments, store])

  const comments = live ?? (drafts.isSuccess ? serverComments : NO_COMMENTS)

  /** The list as it stands NOW — never a render's snapshot, which a send outlives. */
  const current = useCallback(
    (): DiffComment[] => store.lists.get(runId) ?? serverComments,
    [runId, serverComments, store],
  )

  /** Every write is size-checked HERE: the store refuses an over-cap entry, and a refused draft
   *  write is silent by design — so the comments would look kept and be gone after a reload. */
  const write = useCallback(
    (next: DiffComment[]): boolean => {
      const text = next.length === 0 ? '' : JSON.stringify(next)
      if (text.length > DRAFT_TEXT_MAX) {
        toast('Too many comments to keep as a draft — send the ones you have first.', { tone: 'danger' })
        return false
      }
      store.lists.set(runId, next)
      store.listeners.get(runId)?.forEach((listener) => listener())
      // Mirrored into the cached listing, so a later mount (or a reload's first read) agrees.
      queryClient.setQueryData<RunDraftsResponse>(queryKeys.runs.drafts(runId), (listing) => {
        const surfaces = { ...(listing?.surfaces ?? {}) }
        if (text === '') delete surfaces[DIFF_COMMENTS_SURFACE]
        else surfaces[DIFF_COMMENTS_SURFACE] = { text, images: [], updatedAt: new Date().toISOString() }
        return { surfaces }
      })
      // In order, and silent on failure, like every draft write — it must never be louder than
      // the review it carries.
      const chained = (store.chains.get(runId) ?? Promise.resolve())
        .catch(() => {})
        .then(() => putRunDraft(runId, DIFF_COMMENTS_SURFACE, { text, images: [] }))
        .catch(() => {})
      store.chains.set(runId, chained)
      return true
    },
    [queryClient, runId, store],
  )

  const add = useCallback(
    (comment: DiffNewLineComment) =>
      write([
        ...current(),
        {
          ...comment,
          body: comment.body.slice(0, COMMENT_MAX),
          excerpt: capExcerpt(comment.excerpt, comment.start ? RANGE_EXCERPT_MAX : EXCERPT_MAX),
          id: newId(),
        },
      ]),
    [current, write],
  )
  const update = useCallback(
    (id: string, body: string) =>
      write(current().map((c) => (c.id === id ? { ...c, body: body.slice(0, COMMENT_MAX) } : c))),
    [current, write],
  )
  const remove = useCallback((id: string) => void write(current().filter((c) => c.id !== id)), [current, write])
  const clear = useCallback(() => void write([]), [write])

  // Not cleared up front (unlike the composer's optimistic clear): a rejected send must leave
  // every comment exactly where it was, and the chips staying put during the send says so.
  const submit = useCallback(
    async <T>(action: (held: DiffComment[]) => Promise<T>): Promise<T> => {
      const held = current()
      const result = await action(held)
      if (held.length > 0) {
        // Drop what was SENT, as it was sent: a comment added meanwhile, or edited after it was
        // captured, is not what the agent read — it stays a draft for the next message.
        const sent = new Map(held.map((c) => [c.id, c.body]))
        write(current().filter((c) => sent.get(c.id) !== c.body))
      }
      return result
    },
    [current, write],
  )

  return { ready: drafts.isSuccess, comments, add, update, remove, clear, submit }
}
