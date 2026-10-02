/**
 * The `<Diff>` facade contract (spec §"Session git view — Changes & Files tabs (#390)",
 * R5 Step 1.4). These props are OURS — consumers (Changes tab, repo view, commit diff view)
 * import from `@/components/diff` and never from a diff-rendering library. Whatever renders
 * underneath (today: our own renderer; the evaluated `@pierre/diffs` did not fit — see
 * `diff.tsx` header) must satisfy exactly this surface, so swapping engines is a local edit.
 */

/**
 * One changed file, in the server's `/api/runs/:id/changes` / `/api/repo/changes` shape
 * (`ChangedFile` in `src/server/git-changes.ts`) — the facade takes the API payload as-is.
 */
export interface DiffFileChange {
  path: string
  /** Rename/copy source — present only when `status` is renamed/copied. */
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'
  adds: number
  dels: number
  /** Binary per numstat — there is no text patch to render. */
  binary?: boolean
  /** True when the server's raw-bytes route (`/files?raw=1`) will serve this path as an image
   *  (#365) — set from the path's EXTENSION, so it is true for SVGs too. It means "previewable",
   *  NOT "has no text diff": whether the renderer actually swaps the rows for a picture is
   *  `shouldPreviewImage` in `./image-preview`. Present only when true. */
  image?: boolean
  /** This file's unified-diff section (`diff --git …` headers + `@@` hunks), possibly
   *  ending in the server's `… (patch truncated)` marker, possibly empty (metadata-only). */
  patch: string
}

export type DiffMode = 'unified' | 'split'

/**
 * The imperative seam for "reveal this file" (the Changes tab's file tree). It exists because
 * virtualization takes the DOM away: past the threshold in `diff-scroll.ts` an off-screen
 * file has no element to `scrollIntoView`, so the scroll must go through the virtualizer's
 * index instead. The handle hides which of the two is in play.
 */
export interface DiffHandle {
  /** Scroll the file at `path` to the top of the scroll container. A no-op if it isn't in
   *  `files` — a tree selection can race a refetch that dropped the file. */
  scrollToPath: (path: string) => void
}

/**
 * Where a line comment is anchored. A deleted line only exists on the old side, so it is
 * addressed by its old number; every other line (added or context) by its new one — which is
 * what lets a context line's comment show up under the same row in unified AND split layouts.
 */
export interface DiffLineAnchor {
  path: string
  side: 'old' | 'new'
  line: number
}

/** One comment's length cap — generous for prose, but a pasted log must not be able to grow the
 *  host's stored list past what it can keep. Here rather than in `line-comments.tsx` so hosts can
 *  import it without pulling the lazy renderer chunk into the main bundle. */
export const COMMENT_MAX = 4000

/** A line comment as the diff renders it — the host owns storage and identity. */
export interface DiffLineComment extends DiffLineAnchor {
  id: string
  body: string
}

/** What the inline editor hands back: the anchor, the commented line's text, and the note. */
export interface DiffNewLineComment extends DiffLineAnchor {
  /** The file's pre-rename path, set for a removed line of a renamed file — its line number
   *  belongs to the OLD file. */
  oldPath?: string
  /** The commented line's text, so the comment still reads in context once the file moves on. */
  excerpt: string
  body: string
}

export interface DiffProps {
  files: DiffFileChange[]
  /** Layout: one interleaved column, or old|new side by side. Default `unified`. */
  mode?: DiffMode
  /** Soft-wrap long lines instead of horizontal scrolling. Default `false`. */
  wrap?: boolean
  /**
   * Expandable context needs file bytes the patch doesn't carry: given a path, resolve the
   * file's current (new-side) text — the Changes tab wires `/api/runs/:id/files` here (1.5).
   * Resolve `null` when unavailable (binary, deleted, too large); the gap stays collapsed.
   * Absent ⇒ gaps render as static "N unchanged lines" separators.
   */
  loadFileText?: (path: string) => Promise<string | null>
  /**
   * Raw-bytes URL for an image path (#365) — given a path, resolve the same-origin URL an
   * `<img>` can load it from (the Changes tab wires `runFileRawUrl`). Absent ⇒ image files
   * still show the plain "Binary file" note, so consumers that never serve bytes for their
   * files (repo view, commit diffs) need no change to keep working.
   */
  imageSrc?: (path: string) => string
  /**
   * "Open in default app" (#365, LOCAL MODE ONLY): given a path, hand it off to the OS's
   * default application. Absent ⇒ the action is hidden, not disabled — the doctrine every
   * other local-machine affordance in the cockpit follows (`git-actions.ts`).
   */
  onOpenInApp?: (path: string) => void
  /**
   * Receives the {@link DiffHandle}. A plain ref-shaped prop rather than the component's own
   * `ref`, because `<Diff>` lazy-loads its renderer: the handle only exists once that chunk
   * lands, and the fallback renderer has none at all (it never virtualizes, so consumers keep
   * their DOM-based scroll there).
   */
  viewRef?: { current: DiffHandle | null }
  /**
   * Line comments for the agent (the self-review flow): rendered under the line they anchor to.
   * `onAddComment` absent ⇒ no "+" affordance at all; `onRemoveComment` absent ⇒ read-only
   * comments (and `onEditComment` absent ⇒ no Edit). The fallback renderer shows neither — it has no line model to anchor to.
   */
  comments?: readonly DiffLineComment[]
  /** Return `false` to refuse (the host could not keep it) — the editor then stays open with
   *  the text, instead of closing on a comment that was never stored. */
  onAddComment?: (comment: DiffNewLineComment) => boolean | void
  /** Absent ⇒ saved comments offer no Edit. Return `false` to refuse, as above. */
  onEditComment?: (id: string, body: string) => boolean | void
  onRemoveComment?: (id: string) => void
  className?: string
}
