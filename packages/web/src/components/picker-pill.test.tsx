import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PickerPill } from './picker-pill'

describe('PickerPill catalog status', () => {
  afterEach(cleanup)

  it('constrains long descriptions so narrow menus can wrap them', async () => {
    render(
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        label="auto"
        value="long-model"
        onPick={() => {}}
        options={[
          {
            value: 'long-model',
            label: 'Long model',
            desc: 'A model description supplied by the CLI that must wrap instead of widening the menu.',
          },
        ]}
      />,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model' }))
    const description = await screen.findByText(
      'A model description supplied by the CLI that must wrap instead of widening the menu.',
    )

    expect(description.className).toContain('max-w-')
    expect(description.className).toContain('whitespace-normal')
    expect(description.className).toContain('break-words')
  })

  it('keeps radio options selectable and renders a disabled status row', async () => {
    render(
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        label="auto"
        value=""
        onPick={() => {}}
        options={[{ value: '', label: 'auto' }, { value: 'gpt-future', label: 'Future' }]}
        status="Using cached Codex model list"
      />,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model' }))
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(2)
    expect(screen.getByText('Using cached Codex model list').closest('[data-disabled]')).not.toBeNull()
  })

  it('moves from a filtered search into the options for keyboard selection', async () => {
    const onPick = vi.fn()
    render(
      <PickerPill
        slot="branch-pill"
        ariaLabel="Base branch"
        label="main"
        value="main"
        onPick={onPick}
        options={[
          { value: 'main', label: 'main' },
          { value: 'feature/search', label: 'feature/search' },
        ]}
        searchPlaceholder="Search branches…"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Base branch' }))
    const search = await screen.findByRole('combobox', { name: 'Search branches…' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    expect(screen.getByRole('option', { name: 'main' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'feature/search' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.change(search, { target: { value: 'feature' } })
    const option = screen.getByRole('option', { name: 'feature/search' })
    expect(search.getAttribute('aria-activedescendant')).toBe(option.id)
    // Focus never leaves the input — the highlight is aria-activedescendant, not DOM focus.
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('feature/search'))
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
  })

  it('stays open while the pointer moves over rows and back out of the list', async () => {
    render(
      <PickerPill
        slot="branch-pill"
        ariaLabel="Base branch"
        label="main"
        value="main"
        onPick={() => {}}
        options={[
          { value: 'main', label: 'main' },
          { value: 'develop', label: 'develop' },
        ]}
        searchPlaceholder="Search branches…"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Base branch' }))
    const search = await screen.findByRole('combobox', { name: 'Search branches…' })
    await waitFor(() => expect(document.activeElement).toBe(search))

    const develop = screen.getByRole('option', { name: 'develop' })
    fireEvent.pointerMove(develop)
    expect(develop.getAttribute('aria-selected')).toBe('true')
    fireEvent.pointerLeave(develop)
    fireEvent.pointerMove(document.body)
    fireEvent.pointerOver(document.body)

    expect(screen.getByRole('listbox')).not.toBeNull()
    expect(document.activeElement).toBe(search)
  })

  it('windows a long branch list instead of mounting every row', async () => {
    // virtua measures with a ResizeObserver; jsdom has none and lays nothing out.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    const options = Array.from({ length: 5000 }, (_, i) => ({ value: `branch-${i}`, label: `branch-${i}` }))
    render(
      <PickerPill
        slot="branch-pill"
        ariaLabel="Base branch"
        label="main"
        value="branch-0"
        onPick={() => {}}
        options={options}
        searchPlaceholder="Search branches…"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Base branch' }))
    const search = await screen.findByRole('combobox', { name: 'Search branches…' })
    expect(screen.queryAllByRole('option').length).toBeLessThan(200)

    fireEvent.change(search, { target: { value: 'branch-4999' } })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['branch-4999'])
    vi.unstubAllGlobals()
  })
})
