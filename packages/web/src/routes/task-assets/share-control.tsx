import { useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, ClockPlusIcon, CopyIcon, Share2Icon, SquareIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import type { AssetShareStateResponse } from '@open-mercato/cezar-api-client'
import {
  ApiError,
  decideAssetShareGuest,
  extendAssetShare,
  removeAssetShareGuest,
  ShareError,
  startAssetShare,
  stopAssetShare,
} from '@/api/client'
import { queryKeys, useGuestComments, useHealth, useAssetShare } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { toast } from '@/components/ui/toaster'
import { writeClipboard } from '@/lib/clipboard'

import { ShareGuests, useGuestDecisions } from './share-guests'

/** Spec 2026-11-28-asset-share-link § Exposure, verbatim; shown before every start (C8). */
const EXPOSURE =
  "People you let in with this link can open this page, and the images among this task's assets, and comment. Traffic passes through Cloudflare."

type Failure =
  | { kind: 'no-tunnel'; install: string | undefined; message: string }
  | { kind: 'tunnel-failed'; message: string }
  | { kind: 'other'; message: string }

/**
 * The Assets toolbar's Share control (spec 2026-11-28-asset-share-link). Everything shown is
 * read from `useAssetShare` on each render; `share.url` holds the link token, so it reaches the
 * clipboard and nowhere else.
 */
export function ShareControl({
  runId,
  asset,
  assetTitle,
}: {
  runId: string
  /** The listed name of the HTML asset on screen: what Create link shares. */
  asset: string
  /** Its title, the file name when the page has none: named above the exposure text. */
  assetTitle: string
}) {
  const health = useHealth()
  const enabled = health.data?.capabilities?.assetShare === true
  const queryClient = useQueryClient()
  const share = useAssetShare(runId).data?.share ?? null
  const commentCount = useGuestComments(runId).data?.comments.length ?? 0
  const decisions = useGuestDecisions(share?.guests)

  const [open, setOpen] = useState(false)
  // Read after an await: whether the failure has a popover to land in.
  const openRef = useRef(false)
  openRef.current = open
  const [failure, setFailure] = useState<Failure | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  // Synchronous guard: a second click can land before the disabled state renders.
  const inFlight = useRef(new Set<string>())
  const panelRef = useRef<HTMLDivElement>(null)
  // Stop was asked for: an Extend or a guest decision that answers "live" after it is older news.
  const stopAsked = useRef(false)

  // A share that starts or ends (Stop, expiry, a server restart's `{ share: null }`) closes
  // whatever was open for the other state.
  const live = share !== null
  const [shownLive, setShownLive] = useState(live)
  if (shownLive !== live) {
    setShownLive(live)
    setOpen(false)
    setFailure(null)
    // A decision the ended share never answered must not hold the next share's buttons.
    decisions.reset()
    if (live) stopAsked.current = false
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
  // A focus refetch that began before the request must not land after it with the old state.
  // `false` when the answer was dropped: a share its owner stopped never reads as live again.
  const settle = async (next: AssetShareStateResponse): Promise<boolean> => {
    if (stopAsked.current && next.share !== null) return false
    const queryKey = queryKeys.runs.assetShare(runId)
    await queryClient.cancelQueries({ queryKey })
    if (stopAsked.current && next.share !== null) return false
    queryClient.setQueryData<AssetShareStateResponse>(queryKey, next)
    return true
  }
  const failed = (error: unknown) => toast(messageOf(error), { tone: 'danger', expected: explained(error) })

  const start = () => {
    void busy('start', async () => {
      setFailure(null)
      stopAsked.current = false
      try {
        const answer = await startAssetShare(runId, { asset })
        await settle(answer)
        writeClipboard(answer.share.url).then(
          () => toast('Link copied'),
          () => toast('Link ready — use Copy link'),
        )
      } catch (error) {
        if (openRef.current) setFailure(failureOf(error))
        else failed(error)
      }
    })
  }

  const request = (task: () => Promise<AssetShareStateResponse>) => async () => {
    try {
      await settle(await task())
      return true
    } catch (error) {
      failed(error)
      return false
    }
  }

  if (share === null) {
    const starting = pending.has('start')
    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          setFailure(null)
        }}
      >
        <PopoverTrigger asChild>
          {/* The toolbar's own button shape: ghost, one height, the name hidden at phone width. */}
          <Button type="button" data-slot="share-idle" variant="ghost" size="sm" className="text-muted-foreground max-sm:px-1.5">
            <Share2Icon aria-hidden="true" />
            <span className="max-sm:sr-only">Share</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          ref={panelRef}
          tabIndex={-1}
          align="end"
          // Focus the panel, not Create link: a held Enter on Share must not start a share.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            panelRef.current?.focus()
          }}
          className="flex w-80 flex-col gap-3 text-ui"
        >
          <SharePanel title={assetTitle} failure={failure} starting={starting} onStart={start} />
        </PopoverContent>
      </Popover>
    )
  }

  // One share per task (C9): on another asset this names the shared one and offers no second link.
  const sameAsset = asset === share.asset
  const sharedTitle = share.assetTitle !== '' ? share.assetTitle : share.asset
  // The owner cannot act on a waiting guest while sharing is off, so nothing calls for attention.
  const waiting = enabled ? share.guests.filter((guest) => guest.state === 'waiting').length : 0
  const copyLink = () => {
    writeClipboard(share.url).then(
      () => toast('Link copied'),
      () => toast('Could not copy the link'),
    )
  }
  const extend = () =>
    void busy('extend', async () => {
      try {
        const answer = await extendAssetShare(runId)
        if ((await settle(answer)) && answer.share) toast(`Sharing until ${clock(answer.share.expiresAt)}`)
      } catch (error) {
        // Stopped meanwhile: "not sharing" is what the owner asked for, not a failure.
        if (!stopAsked.current) failed(error)
      }
    })
  const stop = () =>
    void busy('stop', async () => {
      stopAsked.current = true
      // A stop that failed stopped nothing: later answers count again.
      if (!(await request(() => stopAssetShare(runId))())) stopAsked.current = false
    })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" data-slot="share-live" variant="ghost" size="sm" className="relative max-w-[min(22rem,60vw)] max-sm:px-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />
          <span data-slot="share-live-label" className="min-w-0 truncate">
            {sameAsset ? `Sharing · ${commentsLabel(commentCount)} · until ${clock(share.expiresAt)}` : `Sharing “${sharedTitle}”`}
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
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
        <div className="flex flex-wrap items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={copyLink}>
            <CopyIcon aria-hidden="true" className="size-3.5" />
            Copy link
          </Button>
          {/* The server refuses it while sharing is off: the capability gate (C4), a paired phone included (C11). */}
          {enabled ? (
            <Button type="button" variant="ghost" size="sm" disabled={pending.has('extend') || pending.has('stop')} onClick={extend}>
              <ClockPlusIcon aria-hidden="true" className="size-3.5" />
              Extend 8 hours
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // Never off for a pending Extend: a live link is always stoppable (spec § States).
            disabled={pending.has('stop')}
            onClick={stop}
          >
            <SquareIcon aria-hidden="true" className="size-3.5" />
            Stop sharing
          </Button>
        </div>
        {share.guests.length > 0 || decisions.held.size > 0 ? (
          <>
            <Separator />
            <ShareGuests
              guests={share.guests}
              // The server refuses decisions while sharing is off; Stop stays (spec § States).
              decisions={enabled}
              state={decisions}
              onDecide={(guest, decision, shown) =>
                decisions.run(guest, decision === 'allow' ? 'allowed' : 'denied', shown, request(() => decideAssetShareGuest(runId, guest.id, decision)))
              }
              onRemove={(guest, shown) => decisions.run(guest, 'removed', shown, request(() => removeAssetShareGuest(runId, guest.id)))}
            />
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** The idle popover: the exposure text above every way to start, a failed start included. */
function SharePanel({
  title,
  failure,
  starting,
  onStart,
}: {
  /** What Create link will share. */
  title: string
  failure: Failure | null
  starting: boolean
  onStart: () => void
}) {
  const exposure = <p className="text-muted-foreground">{EXPOSURE}</p>
  const startButton = (label: string) => (
    <Button type="button" size="sm" className="self-end" disabled={starting} onClick={onStart}>
      {starting ? 'Creating link…' : label}
    </Button>
  )
  if (failure === null || starting) {
    return (
      <div data-slot="share-confirm" className="flex flex-col gap-3">
        <p data-slot="share-asset" className="truncate font-medium">
          Share “{title}”
        </p>
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

/** A 4xx is the server saying why, whichever class carried it: shown, never reported as an error. */
function explained(error: unknown): boolean {
  return (error instanceof ApiError || error instanceof ShareError) && error.status >= 400 && error.status < 500
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
