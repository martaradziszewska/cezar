import { CheckIcon, SearchIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Virtualizer, type VirtualizerHandle } from 'virtua'

import { DEFAULT_AGENT_ACCOUNT_ID, type Runner } from '@open-mercato/cezar-api-client'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RUNNERS } from '@/routes/new-task-form'

/**
 * The composer's single-choice pill, factored out of new-task.tsx (#401) so the follow-up
 * surface reuses the exact same runner/model control — one pill grammar, one place to change it.
 */

/** The mockup's `.chip` — defined once in `components/chip.tsx` (spec 2026-09-14-automations-redesign
 *  § Primitives) and re-exported here for the composer's existing importers. */
import { chipChevron as chevron, chipClass } from '@/components/chip'

export { chevron, chipClass }

/** A generic single-choice pill (runner / model / variants): DropdownMenu radio semantics,
 *  two-line items (label + quiet description), disabled state carries its reason as `title`. */
export function PickerPill({
  slot,
  ariaLabel,
  label,
  value,
  options,
  onPick,
  disabled = false,
  readOnly = false,
  hint,
  disabledHint,
  status,
  searchPlaceholder,
}: {
  slot: string
  ariaLabel: string
  label: ReactNode
  value: string
  options: ReadonlyArray<{ value: string; label: string; desc?: string }>
  onPick: (value: string) => void
  disabled?: boolean
  /** Display the resolved value without presenting a selector. */
  readOnly?: boolean
  /** Hover explanation for the enabled pill — what the setting does (e.g. the ×1 variants pill). */
  hint?: string
  disabledHint?: string
  /** Quiet non-selectable catalog state, kept inside the menu's accessible reading order. */
  status?: string
  /** Add a name filter above longer option catalogs. */
  searchPlaceholder?: string
}) {
  if (readOnly) {
    return (
      <span
        data-slot={slot}
        aria-label={ariaLabel}
        title={disabledHint ?? hint}
        className={`${chipClass} cursor-default hover:bg-card hover:text-muted-foreground`}
      >
        {label}
      </span>
    )
  }
  const trigger = (
    <button
      type="button"
      data-slot={slot}
      aria-label={ariaLabel}
      disabled={disabled}
      title={disabled ? disabledHint : hint}
      className={chipClass}
    >
      {label}
      {chevron}
    </button>
  )
  // Radix never opens a disabled trigger, but `disabled:pointer-events-none` would also kill
  // the explanatory title tooltip — so the disabled pill renders bare, in a plain span wrapper
  // that still receives hover.
  if (disabled) {
    return (
      <span title={disabledHint} className="inline-flex">
        {trigger}
      </span>
    )
  }
  if (searchPlaceholder) {
    return (
      <SearchablePicker
        slot={slot}
        trigger={trigger}
        value={value}
        options={options}
        onPick={onPick}
        searchPlaceholder={searchPlaceholder}
      />
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid={`${slot}-menu`}>
        <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2.5">
              <span className="flex min-w-0 flex-col">
                <span className="text-[12.5px] font-medium">{option.label}</span>
                {option.desc ? (
                  <span className="max-w-[calc(100vw-3rem)] whitespace-normal break-words text-[11.5px] text-muted-foreground md:max-w-96">
                    {option.desc}
                  </span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {status ? (
          <DropdownMenuItem disabled className="border-t border-border text-[11.5px] text-muted-foreground">
            {status}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Rows past which the searchable list goes through virtua — a repo can carry thousands of branches. */
export const PICKER_VIRTUALIZE_THRESHOLD = 100

type PickerOption = { value: string; label: string; desc?: string }

/**
 * The searchable variant (base-branch pill): a Popover over a filtered listbox rather than a
 * Radix menu. Menu items each take DOM focus on hover and re-render the whole collection, which
 * with thousands of branches made opening slow and hovering unstable; here focus stays in the
 * input, hover only moves the highlight, and long lists are windowed.
 */
function SearchablePicker({
  slot,
  trigger,
  value,
  options,
  onPick,
  searchPlaceholder,
}: {
  slot: string
  trigger: ReactNode
  value: string
  options: ReadonlyArray<PickerOption>
  onPick: (value: string) => void
  searchPlaceholder: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizerRef = useRef<VirtualizerHandle>(null)

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options
  }, [options, search])
  const virtual = visible.length > PICKER_VIRTUALIZE_THRESHOLD

  const reveal = (index: number) => {
    if (virtual) virtualizerRef.current?.scrollToIndex(index, { align: 'nearest' })
    else scrollRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }
  const moveTo = (index: number) => {
    if (visible.length === 0) return
    const next = Math.max(0, Math.min(visible.length - 1, index))
    setActive(next)
    reveal(next)
  }
  const pick = (option: PickerOption) => {
    setOpen(false)
    setSearch('')
    onPick(option.value)
  }

  // Open on the current value, so a long list starts where the user's choice is.
  useEffect(() => {
    if (!open) return
    const index = Math.max(0, options.findIndex((option) => option.value === value))
    setActive(index)
    const frame = window.requestAnimationFrame(() => reveal(index))
    return () => window.cancelAnimationFrame(frame)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const row = (option: PickerOption, index: number) => (
    <div
      key={option.value}
      id={`${listId}-${index}`}
      role="option"
      aria-selected={index === active}
      data-index={index}
      data-active={index === active ? '' : undefined}
      // Keep focus in the input: the row is picked on click, never focused.
      onMouseDown={(event) => event.preventDefault()}
      onPointerMove={() => {
        if (index !== active) setActive(index)
      }}
      onClick={() => pick(option)}
      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[active]:bg-accent data-[active]:text-accent-foreground"
    >
      <CheckIcon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[12.5px] font-medium" title={option.label}>
          {option.label}
        </span>
        {option.desc ? (
          <span className="whitespace-normal break-words text-[11.5px] text-muted-foreground">{option.desc}</span>
        ) : null}
      </span>
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        data-testid={`${slot}-menu`}
        className="flex w-[min(28rem,calc(100vw-2rem))] flex-col p-1"
      >
        <div className="mb-1 flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
          <SearchIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={visible.length > 0 ? `${listId}-${active}` : undefined}
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setActive(0)
              scrollRef.current?.scrollTo?.({ top: 0 })
            }}
            onKeyDown={(event) => {
              const page = 8
              const moves: Record<string, number> = {
                ArrowDown: active + 1,
                ArrowUp: active - 1,
                PageDown: active + page,
                PageUp: active - page,
              }
              if (event.key in moves) {
                event.preventDefault()
                moveTo(moves[event.key] as number)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const option = visible[active]
                if (option) pick(option)
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div
          ref={scrollRef}
          id={listId}
          role="listbox"
          aria-label={searchPlaceholder}
          className="max-h-[min(20rem,calc(var(--radix-popover-content-available-height)-3.5rem))] overflow-y-auto overscroll-contain"
        >
          {virtual ? (
            <Virtualizer ref={virtualizerRef} scrollRef={scrollRef} itemSize={30}>
              {visible.map(row)}
            </Virtualizer>
          ) : (
            visible.map(row)
          )}
          {visible.length === 0 ? (
            <p className="px-2 py-5 text-center text-xs text-muted-foreground">No branches found.</p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * One agent account, as this pill needs to show it (spec 2026-07-29-agent-profiles).
 *
 * `id` is the reserved `default` for the DISCOVERED account — the one `agentHomePaths()` finds —
 * and a stored slug otherwise.
 */
export interface RunnerAccountChoice {
  provider: Runner
  id: string
  label: string
  /** The folder, as written. The labels are cezar's invention; the folder IS the account. */
  configDir: string
}

/** How one row of the pill's menu is addressed: the agent, and which of its logins. */
const choiceValue = (runner: Runner, account: string | null): string =>
  account === null ? runner : `${runner}:${account}`

/**
 * Which agent — and, when there is more than one login for it, which account — in ONE flat list:
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     codex
 *
 * Not a runner group with an account group nested under it. Every row is a concrete thing that can
 * run this task, so what will happen is readable at a glance instead of assembled from two
 * selections. An agent with a single login stays a single row, which is why a machine with no extra
 * accounts sees exactly the list it always saw.
 *
 * The pill renders for a CHOICE: more than one runner, or more than one account for one runner. A
 * host with one agent and one login has neither, and the caller leaves it out.
 *
 * Three wire states, and the difference between the first two matters:
 *   - `account === null` — follow the repo's setting. What an untouched pill means, and it stays
 *     true if that setting changes before the task starts.
 *   - `'default'` — the discovered account, EXPLICITLY. Beats the repo setting server-side
 *     (`selectProfile`), which is what makes "claude · Default" mean it in a repo set to another
 *     account.
 *   - a stored id — that account.
 */
export function RunnerPill({
  runners,
  value,
  onPick,
  disabled = false,
  accounts = [],
  account = null,
  repoAccount,
}: {
  runners: readonly Runner[]
  value: Runner
  /** `account` is `null` only while the repo's own choice is still the one in force. */
  onPick: (runner: Runner, account: string | null) => void
  disabled?: boolean
  /** Every login for every runner, discovered accounts included. Empty = the zero-config host. */
  accounts?: readonly RunnerAccountChoice[]
  /** The per-task override. */
  account?: string | null
  /** What the repo's setting resolves to per runner — the row that is selected until overridden. */
  repoAccount?: Partial<Record<Runner, string>>
}) {
  const available = RUNNERS.filter((r) => runners.includes(r.id))
  const options = available.flatMap((runner) => {
    const logins = accounts.filter((entry) => entry.provider === runner.id)
    // One login is not a choice, so it does not become a row of its own — the agent is the row.
    if (logins.length < 2) return [{ value: choiceValue(runner.id, null), label: runner.id, desc: runner.desc }]
    return logins.map((login) => ({
      value: choiceValue(runner.id, login.id),
      label: `${runner.id} · ${login.label}`,
      // The folder, because the label is cezar's invention and the folder is the account.
      desc: login.configDir,
    }))
  })

  // What is selected right now: the override if the user made one, else whatever the repo resolves
  // to, else the discovered account. Falls back to the plain runner row for an agent with one login
  // — and for an override naming an account that has since been deleted, which must not leave the
  // pill pointing at nothing.
  const selected = account ?? repoAccount?.[value] ?? DEFAULT_AGENT_ACCOUNT_ID
  const value_ = options.some((option) => option.value === choiceValue(value, selected))
    ? choiceValue(value, selected)
    : choiceValue(value, null)

  return (
    <PickerPill
      slot="runner-pill"
      ariaLabel="Runner"
      label={options.find((option) => option.value === value_)?.label ?? value}
      value={value_}
      disabled={disabled}
      onPick={(next) => {
        const [runner, picked] = next.split(':')
        onPick(runner as Runner, picked ?? null)
      }}
      options={options}
    />
  )
}
