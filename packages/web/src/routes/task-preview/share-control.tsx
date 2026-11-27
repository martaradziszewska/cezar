import { useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, CopyIcon, Share2Icon, SquareIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import type { PreviewShareGuest, PreviewShareStateResponse } from '@open-mercato/cezar-api-client'
import {
  ApiError,
  decidePreviewShareGuest,
  removePreviewShareGuest,
  ShareError,
  startPreviewShare,
  stopPreviewShare,
} from '@/api/client'
import { queryKeys, useGuestComments, useHealth, usePreviewShare } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { writeClipboard } from '@/lib/clipboard'

/** Spec 2026-11-26-preview-share-link § Exposure, verbatim; shown before every start (C8). */
const EXPOSURE =
  'Anyone with this link can use this app and read whatever your dev server serves, including source files. Traffic passes through Cloudflare.'

type Failure =
  | { kind: 'no-tunnel'; install: string | undefined; message: string }
  | { kind: 'tunnel-failed'; message: string }
  | { kind: 'other'; message: string }

/**
 * The Preview toolbar's Share control (spec 2026-11-26-preview-share-link). Everything shown is
 * read from `usePreviewShare` on each render; `share.url` holds the link token, so it reaches the
 * clipboard and nowhere else.
 */
export function ShareControl({
  runId,
  targetOrigin,
  path,
}: {
  runId: string
  /** The loopback origin of the tab on screen, or null when it has none (same value Design Mode uses). */
  targetOrigin: string | null
  /** Path + search of the tab on screen, for the link's `next`. */
  path: string
}) {
  const health = useHealth()
  const enabled = health.data?.capabilities?.previewShare === true
  const queryClient = useQueryClient()
  const share = usePreviewShare(runId).data?.share ?? null
  const commentCount = useGuestComments(runId).data?.comments.length ?? 0

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  // Synchronous guard: a second click can land before the disabled state renders.
  const inFlight = useRef(new Set<string>())

  // A share that starts or ends (Stop, expiry, a server restart's `{ share: null }`) closes
  // whatever was open for the other state.
  const live = share !== null
  const [shownLive, setShownLive] = useState(live)
  if (shownLive !== live) {
    setShownLive(live)
    setOpen(false)
    setFailure(null)
  }

  if (!enabled && share === null) return null

  async function busy(key: string, task: () => Promise<void>) {
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    setPending(new Set(inFlight.current))
    try {
      await task()
    } finally {
      inFlight.current.delete(key)
      setPending(new Set(inFlight.current))
    }
  }
  const settle = (next: PreviewShareStateResponse) =>
    queryClient.setQueryData<PreviewShareStateResponse>(queryKeys.runs.previewShare(runId), next)

  const start = () => {
    if (targetOrigin === null) return
    void busy('start', async () => {
      setFailure(null)
      try {
        const answer = await startPreviewShare(runId, { target: targetOrigin + path, parentOrigin: window.location.origin })
        settle(answer)
        writeClipboard(answer.share.url).then(
          () => toast('Link copied'),
          () => toast('Link ready — use Copy link'),
        )
      } catch (error) {
        setFailure(failureOf(error))
      }
    })
  }

  const request = (key: string, task: () => Promise<PreviewShareStateResponse>) =>
    void busy(key, async () => {
      try {
        settle(await task())
      } catch (error) {
        toast(messageOf(error), { tone: 'danger', expected: error instanceof ApiError && error.status >= 400 && error.status < 500 })
      }
    })

  if (share === null) {
    const starting = pending.has('start')
    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setFailure(null)
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            data-slot="share-idle"
            variant="outline"
            size="sm"
            disabled={targetOrigin === null}
            // A disabled control cannot open a tooltip, so the reason stays a native title (as Design Mode's).
            title={targetOrigin === null ? 'Sharing works on local http:// addresses' : undefined}
            className="ml-1 disabled:opacity-40"
          >
            <Share2Icon aria-hidden="true" className="size-3.5" />
            Share
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-80 flex-col gap-3 text-ui">
          <SharePanel failure={failure} starting={starting} onStart={start} />
        </PopoverContent>
      </Popover>
    )
  }

  const sameOrigin = targetOrigin === share.target
  const waiting = share.guests.filter((guest) => guest.state === 'waiting').length
  const copyLink = () => {
    writeClipboard(share.url).then(
      () => toast('Link copied'),
      () => toast('Could not copy the link'),
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" data-slot="share-live" variant="outline" size="sm" className="relative ml-1">
          <span aria-hidden="true" className="size-2 rounded-full bg-success" />
          {sameOrigin ? `Sharing · ${commentsLabel(commentCount)} · until ${clock(share.expiresAt)}` : `Sharing ${hostOf(share.target)}`}
          <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-70" />
          {waiting > 0 ? (
            <span
              role="img"
              data-slot="share-attention"
              aria-label={waiting === 1 ? '1 person waiting to join' : `${waiting} people waiting to join`}
              className="absolute -top-1 -right-1 size-2.5 rounded-full bg-info ring-2 ring-background"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" data-slot="share-menu" className="flex w-80 flex-col gap-1 p-1.5 text-ui">
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={copyLink}>
            <CopyIcon aria-hidden="true" className="size-3.5" />
            Copy link
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending.has('stop')}
            onClick={() => request('stop', () => stopPreviewShare(runId))}
          >
            <SquareIcon aria-hidden="true" className="size-3.5" />
            Stop sharing
          </Button>
        </div>
        {share.guests.length > 0 ? (
          <>
            <Separator />
            <ShareGuests
              guests={share.guests}
              // The server refuses decisions while sharing is off; Stop stays (spec § States).
              decisions={enabled}
              pending={pending}
              onDecide={(guest, decision) =>
                request(`guest:${guest.id}`, () => decidePreviewShareGuest(runId, guest.id, decision))
              }
              onRemove={(guest) => request(`guest:${guest.id}`, () => removePreviewShareGuest(runId, guest.id))}
            />
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** Who asked to join: waiting rows first (D3). Name and code are a stranger's text, so text nodes only. */
function ShareGuests({
  guests,
  decisions,
  pending,
  onDecide,
  onRemove,
}: {
  guests: readonly PreviewShareGuest[]
  decisions: boolean
  pending: ReadonlySet<string>
  onDecide: (guest: PreviewShareGuest, decision: 'allow' | 'deny') => void
  onRemove: (guest: PreviewShareGuest) => void
}) {
  const ordered = [...guests.filter((guest) => guest.state === 'waiting'), ...guests.filter((guest) => guest.state === 'allowed')]
  return (
    <TooltipProvider delayDuration={300}>
      <ul aria-label="People on this link" className="flex flex-col">
        {ordered.map((guest) => {
          const text = guest.state === 'waiting' ? `${guest.name} · ${guest.code} wants to join` : guest.name
          const busy = pending.has(`guest:${guest.id}`)
          return (
            <li key={guest.id} data-slot="share-guest" className="flex items-center gap-1 py-1 pl-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0 flex-1 truncate">{text}</span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>
                  {text}
                </TooltipContent>
              </Tooltip>
              {!decisions ? null : guest.state === 'waiting' ? (
                <>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onDecide(guest, 'deny')}>
                    Deny
                  </Button>
                  <Button type="button" size="sm" disabled={busy} onClick={() => onDecide(guest, 'allow')}>
                    Allow
                  </Button>
                </>
              ) : (
                <IconTooltip label="Remove — they can't rejoin this link">
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(guest)}>
                    Remove
                  </Button>
                </IconTooltip>
              )}
            </li>
          )
        })}
      </ul>
    </TooltipProvider>
  )
}

/** The idle popover: the exposure text above every way to start, a failed start included. */
function SharePanel({ failure, starting, onStart }: { failure: Failure | null; starting: boolean; onStart: () => void }) {
  const exposure = <p className="text-muted-foreground">{EXPOSURE}</p>
  const startButton = (label: string) => (
    <Button type="button" size="sm" className="self-end" disabled={starting} onClick={onStart}>
      {starting ? 'Creating link…' : label}
    </Button>
  )
  if (failure === null || starting) {
    return (
      <div data-slot="share-confirm" className="flex flex-col gap-3">
        {exposure}
        {startButton('Create link')}
      </div>
    )
  }
  if (failure.kind === 'no-tunnel') {
    const install = failure.install
    return (
      <div data-slot="share-no-tunnel" className="flex flex-col gap-3">
        <p className="font-medium">Sharing needs cloudflared</p>
        {install ? (
          <div className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1">
            <code className="min-w-0 flex-1 font-mono text-meta break-all select-all">{install}</code>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Copy install command"
              onClick={() => writeClipboard(install).then(() => toast('Command copied'), () => toast('Could not copy the command'))}
            >
              <CopyIcon aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground">{failure.message}</p>
        )}
        {exposure}
        {startButton('Retry')}
      </div>
    )
  }
  return (
    <div data-slot={failure.kind === 'tunnel-failed' ? 'share-tunnel-failed' : 'share-failed'} className="flex flex-col gap-3">
      {failure.kind === 'tunnel-failed' ? <p className="font-medium">The tunnel did not start</p> : null}
      <p role="alert" className="text-danger break-words">
        {failure.message}
      </p>
      {exposure}
      {startButton('Retry')}
    </div>
  )
}

function failureOf(error: unknown): Failure {
  if (error instanceof ShareError && error.code === 'no-tunnel') return { kind: 'no-tunnel', install: error.install, message: error.message }
  if (error instanceof ShareError && error.code === 'tunnel-failed') return { kind: 'tunnel-failed', message: error.message }
  return { kind: 'other', message: messageOf(error) }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong — try again'
}

function commentsLabel(count: number): string {
  return count === 1 ? '1 comment' : `${count} comments`
}

function clock(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}
