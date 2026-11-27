import { FileIcon, MessageSquareIcon, MousePointerClickIcon, XIcon } from 'lucide-react'
import { useId } from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Link } from '@/lib/project-router'

import {
  isAssetComment,
  isGuestComment,
  linesLabel,
  sortReviewComments,
  type AssetComment,
  type DiffComment,
  type GuestReviewComment,
  type ReviewComment,
} from './diff-comments'
import { assetCommentTarget, previewTarget, reviewTarget } from './review-comments-block'

/**
 * The diff comments as draft items in the thread composer — one chip per comment, `file +line`,
 * the way a review tool shows pending review notes beside the reply box. The label links back to
 * the Changes tab (where the comment lives in context); the ✕ drops just that comment.
 */
export function DiffCommentChips({
  runId,
  comments,
  onRemove,
  onOpen,
  onOpenInPreview,
}: {
  runId: string
  comments: readonly ReviewComment[]
  onRemove: (id: string) => void
  /** Given, a LINE comment's label is a button that calls this — the Changes tab, where a link to
   *  itself would do nothing, scrolls the diff to the comment's file instead. Absent, it links to
   *  the tab. An asset comment always links to its asset. */
  onOpen?: (comment: DiffComment) => void
  /** Given (the task workspace), a GUEST comment's label is a button that opens the Preview on its
   *  page. Absent, it links to the Preview tab. */
  onOpenInPreview?: (url: string) => void
}) {
  if (comments.length === 0) return null
  return (
    // The cockpit's own tooltip, not the browser's `title`: themed, shown on keyboard focus as well
    // as hover, and able to lay out a multi-line comment instead of one run-on line.
    <TooltipProvider delayDuration={300}>
      {sortReviewComments(comments).map((comment) => {
        if (isAssetComment(comment)) return <AssetCommentChip key={comment.id} runId={runId} comment={comment} onRemove={onRemove} />
        if (isGuestComment(comment)) {
          return (
            <GuestCommentChip key={comment.id} runId={runId} comment={comment} onRemove={onRemove} onOpenInPreview={onOpenInPreview} />
          )
        }
        const name = comment.path.split('/').at(-1) ?? comment.path
        const sign = (side: 'old' | 'new') => (side === 'old' ? '−' : '+')
        const span =
          comment.start && (comment.start.side !== comment.side || comment.start.line !== comment.line) ?
            comment.start.side === comment.side ?
              `${sign(comment.side)}${comment.start.line}–${comment.line}`
            : `${sign(comment.start.side)}${comment.start.line}–${sign(comment.side)}${comment.line}`
          : `${sign(comment.side)}${comment.line}`
        const label = `${name} ${span}`
        // Spoken: the side in words (`−4` and `+4` must not sound alike) and never the body —
        // a 4000-character note read out on every chip. The body is the tooltip.
        const where = linesLabel(comment)
        return (
          <Tooltip key={comment.id}>
            <TooltipTrigger asChild>
              <span
                data-slot="diff-comment-chip"
                className="flex h-8 max-w-[260px] items-center overflow-hidden rounded-md border border-border bg-muted/40 text-xs text-foreground"
              >
                <span aria-hidden="true" className="flex h-full items-center border-r border-border px-2 text-muted-foreground">
                  <FileIcon className="size-3.5" />
                </span>
                {onOpen ? (
                  <button
                    type="button"
                    onClick={() => onOpen(comment)}
                    className="min-w-0 truncate px-2 font-medium hover:underline"
                    aria-label={`Show comment on ${comment.path} ${where}`}
                  >
                    {label}
                  </button>
                ) : (
                  <Link
                    // Straight to THIS comment on the Changes tab, not the top of its file.
                    to={reviewTarget(runId, {
                      path: comment.path,
                      side: comment.side,
                      line: comment.line,
                      commentId: comment.id,
                    })}
                    className="min-w-0 truncate px-2 font-medium hover:underline"
                    aria-label={`Comment on ${comment.path} ${where}`}
                  >
                    {label}
                  </Link>
                )}
                <button
                  type="button"
                  aria-label={`Remove comment on ${name} ${where}`}
                  onClick={() => onRemove(comment.id)}
                  className="flex h-full items-center px-1.5 text-soft-foreground hover:bg-muted hover:text-foreground"
                >
                  <XIcon aria-hidden="true" className="size-3.5" />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-[320px] text-left">
              <div data-slot="diff-comment-tooltip" className="flex flex-col gap-1">
                <span className="font-mono text-meta text-contrast-foreground/80">
                  {comment.path} · {where}
                </span>
                <span className="line-clamp-6 break-words whitespace-pre-wrap">{comment.body}</span>
              </div>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </TooltipProvider>
  )
}

/** The element's short name: the selector's last step (`h2`, `button.primary`). */
export function selectorTail(selector: string): string {
  return selector.split(' > ').at(-1) ?? selector
}

/** An asset element comment's chip: `mockup.html · h2`, linking to the asset on the Assets tab. */
function AssetCommentChip({
  runId,
  comment,
  onRemove,
}: {
  runId: string
  comment: AssetComment
  onRemove: (id: string) => void
}) {
  const name = comment.asset.split('/').at(-1) ?? comment.asset
  const element = comment.label || selectorTail(comment.selector)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-slot="diff-comment-chip"
          data-kind="asset"
          className="flex h-8 max-w-[260px] items-center overflow-hidden rounded-md border border-border bg-muted/40 text-xs text-foreground"
        >
          <span aria-hidden="true" className="flex h-full items-center border-r border-border px-2 text-muted-foreground">
            <MousePointerClickIcon className="size-3.5" />
          </span>
          <Link
            to={assetCommentTarget(runId, comment.asset)}
            className="min-w-0 truncate px-2 font-medium hover:underline"
            aria-label={`Comment on ${comment.asset} element ${element}`}
          >
            {name} · {selectorTail(comment.selector)}
          </Link>
          <button
            type="button"
            aria-label={`Remove comment on ${name} element ${element}`}
            onClick={() => onRemove(comment.id)}
            className="flex h-full items-center px-1.5 text-soft-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-[320px] text-left">
        <div data-slot="diff-comment-tooltip" className="flex flex-col gap-1">
          <span className="font-mono text-meta break-all text-contrast-foreground/80">
            {comment.asset} · {comment.selector}
          </span>
          <span className="line-clamp-6 break-words whitespace-pre-wrap">{comment.body}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** A guest's comment on the shared Preview: `Ana · button.primary “Save”`, opening the Preview.
 *  No edit: they are someone else's words (spec 2026-11-26-preview-share-link, C6). */
function GuestCommentChip({
  runId,
  comment,
  onRemove,
  onOpenInPreview,
}: {
  runId: string
  comment: GuestReviewComment
  onRemove: (id: string) => void
  onOpenInPreview?: (url: string) => void
}) {
  // Stranger-typed text: folded to one line, and only ever rendered as text nodes.
  const author = oneLine(comment.author)
  const label = oneLine(comment.label)
  const tail = selectorTail(oneLine(comment.selector))
  const element = label || tail
  const opens = `Comment from ${author} on ${comment.url} element ${element}`
  const heldId = useId()
  // What the next send would leave behind (spec 2026-11-26-preview-share-link § Exposure). The
  // label above replaces the chip's text for a screen reader, so the badge is its description.
  const badge =
    comment.fresh ?
      <span
        id={heldId}
        data-slot="guest-comment-new"
        aria-label="New: a review sent now leaves it behind"
        className="mr-1.5 rounded-sm bg-foreground/10 px-1 text-[10px] font-semibold tracking-wide uppercase"
      >
        new
      </span>
    : null
  const described = comment.fresh ? heldId : undefined
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-slot="diff-comment-chip"
          data-kind="guest"
          className="flex h-8 max-w-[260px] items-center overflow-hidden rounded-md border border-border bg-muted/40 text-xs text-foreground"
        >
          <span aria-hidden="true" className="flex h-full items-center border-r border-border px-2 text-muted-foreground">
            <MessageSquareIcon className="size-3.5" />
          </span>
          {onOpenInPreview ? (
            <button
              type="button"
              onClick={() => onOpenInPreview(comment.url)}
              className="min-w-0 truncate px-2 font-medium hover:underline"
              aria-label={opens}
              aria-describedby={described}
            >
              {badge}
              {author} · {tail}
              {label ? ` “${label}”` : null}
            </button>
          ) : (
            <Link
              to={previewTarget(runId)}
              className="min-w-0 truncate px-2 font-medium hover:underline"
              aria-label={opens}
              aria-describedby={described}
            >
              {badge}
              {author} · {tail}
              {label ? ` “${label}”` : null}
            </Link>
          )}
          <button
            type="button"
            aria-label={`Remove comment from ${author} on element ${element}`}
            onClick={() => onRemove(comment.id)}
            className="flex h-full items-center px-1.5 text-soft-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-[320px] text-left">
        {/* Everything the agent will read, uncut and scrolling: the owner can only gate what they
            can see (spec 2026-11-26-preview-share-link, C1). */}
        <div data-slot="diff-comment-tooltip" className="flex max-h-80 flex-col gap-1 overflow-auto">
          <span className="font-mono text-meta break-all text-contrast-foreground/80">
            {author} · {comment.url} · {comment.selector}
            {label ? ` “${label}”` : null}
          </span>
          {comment.component ? (
            <span className="font-mono text-meta break-all text-contrast-foreground/80">component: {comment.component}</span>
          ) : null}
          {comment.excerpt ? (
            <pre data-slot="guest-comment-excerpt" className="font-mono text-meta break-all whitespace-pre-wrap text-contrast-foreground/80">
              {comment.excerpt}
            </pre>
          ) : null}
          <span className="break-words whitespace-pre-wrap">{comment.body}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function oneLine(text: string): string {
  return text.replace(/[\s\u0085]+/g, ' ').trim()
}
