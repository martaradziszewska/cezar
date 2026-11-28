import { useEffect, useRef, useState } from 'react'

import type { AssetShareGuest } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** How long the rows stay put after a decision settles: longer than a double click's second press. */
export const SETTLE_MS = 600

type Outcome = 'allowed' | 'denied' | 'removed'
type Held = { name: string; outcome: Outcome; done: boolean }

export interface GuestDecisions {
  /** True while a decision is in flight or the rows moved on their own, and for `SETTLE_MS` after:
   *  every row's buttons are off. */
  locked: boolean
  held: ReadonlyMap<string, Held>
  /** The row order the owner was looking at when they decided, kept until the window ends. */
  order: readonly string[] | null
  run: (guest: AssetShareGuest, outcome: Outcome, shown: readonly string[], task: () => Promise<boolean>) => void
  /** The share ended: nothing of it, an unanswered decision included, may hold the next one's buttons. */
  reset: () => void
}

const NO_GUESTS: readonly AssetShareGuest[] = []

/** The rows the owner did not just decide, in the server's order: what a change of is not theirs. */
function othersOf(guests: readonly AssetShareGuest[], own: ReadonlyMap<string, unknown>): string {
  return guests
    .filter((guest) => !own.has(guest.id))
    .map((guest) => `${guest.id}:${guest.state}`)
    .join(' ')
}

/**
 * One guard for Allow / Deny / Remove (spec 2026-11-28-asset-share-link, D3): rows are added by
 * anyone holding the link, and the server re-sorts and drops them, so without it a stranger's
 * Allow slides under the pointer.
 */
export function useGuestDecisions(guests: readonly AssetShareGuest[] = NO_GUESTS): GuestDecisions {
  const [deciding, setDeciding] = useState(false)
  const [held, setHeld] = useState<ReadonlyMap<string, Held>>(() => new Map())
  const [order, setOrder] = useState<readonly string[] | null>(null)
  const lock = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Rows that moved for any reason but the owner's own decision; `moves` restarts the wait.
  const [moved, setMoved] = useState(false)
  const [moves, setMoves] = useState(0)
  const lastMove = useRef(0)
  const movedNow = useRef(false)
  /** A row moved while a decision held the order: it shows only when the rows are let go. */
  const movedWhileHeld = useRef(false)
  /** A decision answered after its share ended belongs to no row any more. */
  const generation = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  const disturb = () => {
    movedNow.current = true
    lastMove.current += 1
    setMoved(true)
    setMoves(lastMove.current)
  }
  // Judged while rendering, so the frame that shows the moved rows already has them disabled.
  const [known, setKnown] = useState(guests)
  if (known !== guests) {
    setKnown(guests)
    if (othersOf(known, held) !== othersOf(guests, held)) {
      if (lock.current) movedWhileHeld.current = true
      disturb()
    }
  }
  useEffect(() => {
    if (moves === 0) return
    const wait = setTimeout(() => {
      // A later move's wait is the one that ends it.
      if (lastMove.current !== moves) return
      movedNow.current = false
      setMoved(false)
    }, SETTLE_MS)
    return () => clearTimeout(wait)
  }, [moves])

  const release = () => {
    clearTimeout(timer.current)
    lock.current = false
    setDeciding(false)
    setHeld(new Map())
    setOrder(null)
  }
  const reset = () => {
    generation.current += 1
    movedWhileHeld.current = false
    movedNow.current = false
    setMoved(false)
    release()
  }
  const run: GuestDecisions['run'] = (guest, outcome, shown, task) => {
    if (lock.current || movedNow.current) return
    lock.current = true
    clearTimeout(timer.current)
    setDeciding(true)
    setOrder((current) => current ?? shown)
    setHeld((current) => new Map(current).set(guest.id, { name: guest.name, outcome, done: false }))
    const asked = generation.current
    void task().then((ok) => {
      if (generation.current !== asked) return
      setHeld((current) => {
        const next = new Map(current)
        if (ok) next.set(guest.id, { name: guest.name, outcome, done: true })
        else next.delete(guest.id)
        return next
      })
      timer.current = setTimeout(() => {
        // Letting the rows go is what shows a row that arrived meanwhile.
        if (movedWhileHeld.current) disturb()
        movedWhileHeld.current = false
        release()
      }, SETTLE_MS)
    })
  }
  return { locked: deciding || moved, held, order, run, reset }
}

/** Waiting rows first, unless a decision just froze the order the owner was looking at. */
export function guestOrder(guests: readonly AssetShareGuest[], frozen: readonly string[] | null): string[] {
  const sorted = [...guests.filter((guest) => guest.state === 'waiting'), ...guests.filter((guest) => guest.state === 'allowed')]
  if (frozen === null) return sorted.map((guest) => guest.id)
  return [...frozen, ...sorted.map((guest) => guest.id).filter((id) => !frozen.includes(id))]
}

/** Who asked to join (D3). Name and code are a stranger's text: text nodes only, the name bidi-isolated
 *  and truncated on its own so it can never hide or reorder the code (C12). */
export function ShareGuests({
  guests,
  decisions,
  state,
  onDecide,
  onRemove,
}: {
  guests: readonly AssetShareGuest[]
  /** False while sharing is off: the server refuses decisions then. */
  decisions: boolean
  state: GuestDecisions
  onDecide: (guest: AssetShareGuest, decision: 'allow' | 'deny', shown: readonly string[]) => void
  onRemove: (guest: AssetShareGuest, shown: readonly string[]) => void
}) {
  const byId = new Map(guests.map((guest) => [guest.id, guest]))
  const shown = guestOrder(guests, state.order)
  return (
    <TooltipProvider delayDuration={300}>
      <ul aria-label="People on this link" className="flex flex-col">
        {shown.map((id) => {
          const guest = byId.get(id)
          const hold = state.held.get(id)
          // A settled decision, or a denied guest the server already dropped, keeps its slot.
          if (hold && (hold.done || guest === undefined)) {
            return (
              <li key={id} data-slot="share-guest" className="flex h-[38px] items-center py-1 pl-2 text-muted-foreground">
                <span data-slot="share-guest-label" className="flex min-w-0 flex-1">
                  <GuestName name={hold.name} />
                  <span className="shrink-0 whitespace-pre">{` — ${hold.outcome}`}</span>
                </span>
              </li>
            )
          }
          if (guest === undefined) return null
          const off = state.locked
          return (
            <li key={id} data-slot="share-guest" className="flex items-center gap-1 py-1 pl-2">
              <span data-slot="share-guest-label" className="flex min-w-0 flex-1">
                <GuestName name={guest.name} />
                {guest.state === 'waiting' ? (
                  <span data-slot="share-guest-code" className="shrink-0 whitespace-pre">
                    {' · '}
                    <span className="font-mono tabular-nums">{guest.code}</span>
                    {' wants to join'}
                  </span>
                ) : null}
              </span>
              {!decisions ? null : guest.state === 'waiting' ? (
                <>
                  <Button type="button" variant="outline" size="sm" disabled={off} onClick={() => onDecide(guest, 'deny', shown)}>
                    Deny
                  </Button>
                  <Button type="button" size="sm" disabled={off} onClick={() => onDecide(guest, 'allow', shown)}>
                    Allow
                  </Button>
                </>
              ) : (
                <IconTooltip label="Remove — they can't rejoin this link">
                  <Button type="button" variant="ghost" size="sm" disabled={off} onClick={() => onRemove(guest, shown)}>
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

/** Focusable so the full name in the tooltip is reachable from the keyboard. */
function GuestName({ name }: { name: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <bdi tabIndex={0} className="min-w-0 truncate rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {name}
        </bdi>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <bdi>{name}</bdi>
      </TooltipContent>
    </Tooltip>
  )
}
