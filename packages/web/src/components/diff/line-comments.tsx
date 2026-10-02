import { MessageSquareOffIcon, PencilIcon, PlusIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { isSubmitShortcut } from '@/lib/use-submit-shortcut'
import { cn } from '@/lib/utils'

import type { HunkLine } from './parse-patch'
import type { DiffLineAnchor, DiffLineComment, DiffNewLineComment } from './types'

/**
 * Line comments inside the diff renderer — the self-review flow: hover a line, press "+", leave
 * a note for the agent. The renderer only DRAWS them; storage, identity and delivery belong to
 * the host (the Changes tab files them as a draft the thread composer sends with the next
 * message).
 *
 * Reached through context rather than threaded through the card → body → row chain: every row
 * needs it, and none of the layers in between does.
 */

/** A line's anchor, or `undefined` for a line that has no number on the side it lives on. */
export function anchorForLine(path: string, line: HunkLine): DiffLineAnchor | undefined {
  if (line.kind === 'del') return line.oldLine === undefined ? undefined : { path, side: 'old', line: line.oldLine }
  return line.newLine === undefined ? undefined : { path, side: 'new', line: line.newLine }
}

export function anchorKey(anchor: DiffLineAnchor): string {
  return `${anchor.side}:${anchor.line}\u0000${anchor.path}`
}

/** The one open editor (one at a time, like a review tool): a new comment, or a saved one being
 *  edited in place (`commentId` set). */
export interface LineCommentEditing {
  /** The `pendingText` slot — per new-comment anchor, or per edited comment. */
  key: string
  /** The row the editor hangs under (`anchorKey`). */
  threadKey: string
  anchor: DiffLineAnchor
  excerpt: string
  commentId?: string
  initial?: string
}

export interface LineCommentsApi {
  byKey: ReadonlyMap<string, readonly DiffLineComment[]>
  editing: LineCommentEditing | null
  canAdd: boolean
  open: (anchor: DiffLineAnchor, excerpt: string) => void
  /** Absent ⇒ saved comments are read-only. */
  edit?: (comment: DiffLineComment) => void
  cancel: () => void
  submit: (comment: DiffNewLineComment) => void
  update: (id: string, body: string) => void
  remove?: (id: string) => void
  /** Unsent editor text, kept OUTSIDE React state: virtualization can unmount the editor's row
   *  mid-sentence, and a keystroke must not re-render every row of the diff. */
  pendingText: Map<string, string>
}

export const LineCommentsContext = createContext<LineCommentsApi | null>(null)

export function useLineComments(): LineCommentsApi | null {
  return useContext(LineCommentsContext)
}

/** The hover "+" in a line's marker column. Rendered only when the host can take a comment. */
export function AddCommentButton({ anchor, excerpt }: { anchor: DiffLineAnchor | undefined; excerpt: string }) {
  const api = useLineComments()
  if (!api?.canAdd || anchor === undefined) return null
  return (
    <button
      type="button"
      data-slot="diff-add-comment"
      aria-label={`Comment on ${anchor.side === 'old' ? 'removed ' : ''}line ${anchor.line}`}
      title="Add a comment for the agent"
      onClick={() => api.open(anchor, excerpt)}
      className={cn(
        'absolute top-1/2 -left-2.5 z-[1] flex size-[18px] -translate-y-1/2 items-center justify-center rounded-sm',
        'bg-primary text-primary-foreground opacity-0 shadow-xs transition-opacity',
        'group-hover/line:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <PlusIcon aria-hidden="true" className="size-3" strokeWidth={2.5} />
    </button>
  )
}

/**
 * Everything that hangs under one row: its saved comments, then the editor when it is open
 * there. `anchors` is one entry in unified mode and up to two (old + new cell) in split mode;
 * a split context row maps both cells to the same anchor, so keys are deduplicated.
 */
export function LineCommentThread({ anchors }: { anchors: readonly (DiffLineAnchor | undefined)[] }) {
  const api = useLineComments()
  if (!api) return null
  const keys = [...new Set(anchors.filter((a): a is DiffLineAnchor => a !== undefined).map(anchorKey))]
  const comments = keys.flatMap((key) => api.byKey.get(key) ?? [])
  const editing = api.editing !== null && keys.includes(api.editing.threadKey) ? api.editing : null
  if (comments.length === 0 && editing === null) return null
  const editingId = editing?.commentId
  return (
    <div data-slot="diff-line-comments" className="border-y border-border/50 bg-muted/30 py-2 font-sans">
      {/* Sticky + capped: in no-wrap mode the rows are as wide as the longest line, and the
          editor's buttons must not end up scrolled off to the right of it. */}
      <div className="sticky left-0 flex w-full max-w-2xl flex-col gap-2 px-3 md:pl-24">
        {comments.map((comment) =>
          // The comment being edited is swapped for its editor, in place.
          comment.id === editingId && editing ?
            <CommentEditor key={editing.key} editing={editing} api={api} />
          : <SavedComment key={comment.id} comment={comment} onEdit={api.edit} onRemove={api.remove} />,
        )}
        {editing && editingId === undefined ? <CommentEditor key={editing.key} editing={editing} api={api} /> : null}
      </div>
    </div>
  )
}

function SavedComment({
  comment,
  onEdit,
  onRemove,
}: {
  comment: DiffLineComment
  onEdit?: (comment: DiffLineComment) => void
  onRemove?: (id: string) => void
}) {
  return (
    <div
      data-slot="diff-line-comment"
      className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-[13px] leading-normal"
    >
      <p className="break-words whitespace-pre-wrap text-foreground">{comment.body}</p>
      {onEdit || onRemove ? (
        <div className="flex items-center justify-end gap-1.5">
          {onEdit ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(comment)}>
              <PencilIcon aria-hidden="true" className="size-3.5" />
              Edit
            </Button>
          ) : null}
          {onRemove ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onRemove(comment.id)}>
              <MessageSquareOffIcon aria-hidden="true" className="size-3.5" />
              Remove from chat
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function CommentEditor({
  editing,
  api,
}: {
  editing: NonNullable<LineCommentsApi['editing']>
  api: LineCommentsApi
}) {
  const [text, setText] = useState(() => api.pendingText.get(editing.key) ?? editing.initial ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const body = text.trim()
  const submit = () => {
    if (body === '') return
    api.pendingText.delete(editing.key)
    if (editing.commentId !== undefined) api.update(editing.commentId, body)
    else api.submit({ ...editing.anchor, excerpt: editing.excerpt, body })
  }
  const cancel = () => {
    api.pendingText.delete(editing.key)
    api.cancel()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
      return
    }
    if (
      isSubmitShortcut({
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
      })
    ) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div data-slot="diff-comment-editor" className="flex flex-col gap-2">
      <textarea
        ref={ref}
        rows={3}
        value={text}
        aria-label={`Comment on line ${editing.anchor.line}`}
        placeholder="Add a comment for the AI"
        onChange={(event) => {
          setText(event.target.value)
          api.pendingText.set(editing.key, event.target.value)
        }}
        onKeyDown={onKeyDown}
        className="block w-full resize-y rounded-md border border-ring/60 bg-background px-3 py-2 text-base leading-normal outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-[3px] focus:ring-ring/15 md:text-sm"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={body === ''} onClick={submit}>
          {editing.commentId !== undefined ? 'Save' : 'Comment'} <span aria-hidden="true">↵</span>
        </Button>
      </div>
    </div>
  )
}
