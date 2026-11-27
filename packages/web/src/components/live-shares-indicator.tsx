import { useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, SquareIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import type { LiveSharesResponse } from '@open-mercato/cezar-api-client'
import { stopPreviewShare } from '@/api/client'
import { useLiveShares, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { previewTarget } from '@/routes/task-thread/review-comments-block'

type LiveShare = LiveSharesResponse['shares'][number]

/**
 * The workspace-wide "N live links" bar (spec 2026-11-26-preview-share-link, C7). It shows whenever a
 * share is live, even with sharing switched off: a live link must always be visible and stoppable.
 * The listing carries no link, so nothing here can show or copy one.
 */
export function LiveSharesIndicator() {
  const shares = useLiveShares().data?.shares ?? []
  const queryClient = useQueryClient()
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set())
  // Synchronous guard: a second click can land before the disabled state renders.
  const inFlight = useRef(new Set<string>())
  const [open, setOpen] = useState(false)

  if (shares.length === 0) return null
  const waiting = shares.reduce((sum, share) => sum + share.waiting, 0)
  const label = `${shares.length === 1 ? '1 live link' : `${shares.length} live links`}${waiting > 0 ? ` · ${waiting} waiting` : ''}`

  const stop = async (share: LiveShare) => {
    const key = `${share.projectId}/${share.runId}`
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    setStopping(new Set(inFlight.current))
    try {
      await stopPreviewShare(share.runId, share.projectId)
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.liveShares })
    } catch (error) {
      toast(error instanceof Error && error.message !== '' ? error.message : 'Could not stop sharing — try again', { tone: 'danger' })
    } finally {
      inFlight.current.delete(key)
      setStopping(new Set(inFlight.current))
    }
  }

  return (
    <div data-slot="live-shares" role="status" className="flex min-h-9 items-center gap-2 border-b border-border bg-success/10 px-4 text-sm text-foreground">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1">
            <span data-slot="live-shares-label">{label}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-80 flex-col gap-1 p-1.5 text-ui">
          <ul aria-label="Live links" className="flex flex-col">
            {shares.map((share) => {
              const key = `${share.projectId}/${share.runId}`
              const host = hostOf(share.target)
              return (
                <li key={key} data-slot="live-share" className="flex items-center gap-1 py-1 pl-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span data-slot="live-share-title" className="truncate font-medium">
                      {share.title !== '' ? share.title : host}
                    </span>
                    <span className="truncate text-meta text-muted-foreground">
                      {host}
                      {share.waiting > 0 ? ` · ${share.waiting} waiting` : ''}
                    </span>
                  </span>
                  <Button asChild variant="ghost" size="sm">
                    {/* The bar outlives the navigation, so the list would stay open over the Preview. */}
                    <Link to={`/p/${encodeURIComponent(share.projectId)}${previewTarget(share.runId)}`} onClick={() => setOpen(false)}>
                      Open
                    </Link>
                  </Button>
                  <Button type="button" variant="ghost" size="sm" disabled={stopping.has(key)} onClick={() => void stop(share)}>
                    <SquareIcon aria-hidden="true" className="size-3.5" />
                    Stop sharing
                  </Button>
                </li>
              )
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/**
 * `Sharing` on the row of a task whose Preview is shared (C7). One workspace query feeds every row;
 * the run id alone is not enough, since another project can hold a run of the same id.
 */
export function TaskShareBadge({ runId, projectId }: { runId: string; projectId: string | null }) {
  const live = useLiveShares()
  if (live.isError || !live.data) return null
  if (!live.data.shares.some((share) => share.runId === runId && share.projectId === projectId)) return null
  return (
    <span
      data-slot="task-share-badge"
      title="This task's Preview is shared by link"
      className="shrink-0 rounded-full bg-success/15 px-1.5 py-px text-micro font-medium text-success"
    >
      Sharing
    </span>
  )
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}
