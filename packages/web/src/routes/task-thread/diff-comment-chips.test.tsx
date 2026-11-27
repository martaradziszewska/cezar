import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DiffCommentChips } from './diff-comment-chips'
import { formatDiffComments, parseReviewMessage, type DiffComment, type GuestReviewComment } from './diff-comments'
import { ReviewCommentsBlock } from './review-comments-block'

afterEach(cleanup)

const base: DiffComment = { id: 'a', path: 'src/app/page.tsx', side: 'new', line: 11, body: 'note', excerpt: '' }

function renderChips(comments: DiffComment[]) {
  render(
    <MemoryRouter>
      <DiffCommentChips runId="r1" comments={comments} onRemove={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('diff comment chips', () => {
  it('labels one line, a same-side range, and a range across removed and added lines', () => {
    renderChips([
      base,
      { ...base, id: 'b', line: 14, start: { side: 'new', line: 12 } },
      { ...base, id: 'c', line: 30, start: { side: 'old', line: 28 } },
    ])
    expect(screen.getByText('page.tsx +11')).not.toBeNull()
    expect(screen.getByText('page.tsx +12–14')).not.toBeNull()
    expect(screen.getByText('page.tsx −28–+30')).not.toBeNull()
  })

  it('speaks the span in words and never reads the body out', () => {
    renderChips([{ ...base, line: 14, start: { side: 'new', line: 12 }, body: 'x'.repeat(4000) }])
    const link = screen.getByRole('link')
    expect(link.getAttribute('aria-label')).toBe('Comment on src/app/page.tsx lines 12–14')
    // Straight to this comment on the Changes tab, not the top of its file.
    expect(link.getAttribute('href')).toBe('/tasks/r1/changes?file=src%2Fapp%2Fpage.tsx&side=new&line=14&comment=a')
    expect(screen.getByRole('button', { name: 'Remove comment on page.tsx lines 12–14' })).not.toBeNull()
  })

  it("explains the comment in the cockpit's tooltip, not the browser's title", async () => {
    // Radix positions the tooltip with floating-ui, which measures — jsdom has no observer.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    renderChips([{ ...base, line: 14, start: { side: 'new', line: 12 }, body: 'collapse these\ninto one' }])
    const chip = document.querySelector<HTMLElement>('[data-slot="diff-comment-chip"]')!
    expect(chip.hasAttribute('title')).toBe(false)

    // Keyboard focus opens it as well as hover.
    fireEvent.focus(screen.getByRole('link'))
    const tooltip = await waitFor(() => {
      const found = document.querySelector('[data-slot="diff-comment-tooltip"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(tooltip.textContent).toContain('src/app/page.tsx · lines 12–14')
    expect(tooltip.textContent).toContain('collapse these')
    vi.unstubAllGlobals()
  })
})

describe('asset comment chips', () => {
  it('names the asset and the element, links to the asset, and never reads the body out', () => {
    render(
      <MemoryRouter>
        <DiffCommentChips
          runId="r1"
          comments={[
            base,
            { kind: 'asset', id: 'e', asset: 'mock/recipe.html', selector: 'main > h2.title', label: 'Ingredients', excerpt: '', body: 'x'.repeat(500) },
          ]}
          onRemove={vi.fn()}
        />
      </MemoryRouter>,
    )
    const link = screen.getByText('recipe.html · h2.title')
    expect(link.getAttribute('href')).toBe('/tasks/r1/assets/mock%2Frecipe.html')
    expect(link.getAttribute('aria-label')).toBe('Comment on mock/recipe.html element Ingredients')
    expect(screen.getByRole('button', { name: 'Remove comment on recipe.html element Ingredients' })).not.toBeNull()
    // Line comments still come first.
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['page.tsx +11', 'recipe.html · h2.title'])
  })
})

describe('guest comment chips (spec 2026-11-26-preview-share-link)', () => {
  const guest: GuestReviewComment = {
    kind: 'guest',
    id: 'g1',
    revision: 1,
    author: 'Ana',
    createdAt: '2026-11-26T10:00:00.000Z',
    url: 'http://localhost:5173/settings',
    selector: 'main > form > button.btn-primary',
    label: 'Save',
    excerpt: '',
    body: 'brand green',
  }

  it('names the guest and the element, opens the Preview, removes on ✕, and offers no edit', () => {
    const onRemove = vi.fn()
    render(
      <MemoryRouter>
        <DiffCommentChips runId="r1" comments={[guest, base]} onRemove={onRemove} />
      </MemoryRouter>,
    )
    const link = screen.getByText('Ana · button.btn-primary “Save”')
    expect(link.getAttribute('href')).toBe('/tasks/r1/preview')
    expect(link.closest('[data-slot="diff-comment-chip"]')?.getAttribute('data-kind')).toBe('guest')
    // After the owner's own comments.
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['page.tsx +11', 'Ana · button.btn-primary “Save”'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment from Ana on element Save' }))
    expect(onRemove).toHaveBeenCalledWith('g1')
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
  })

  it('badges a comment the next send would hold back, and only that one', () => {
    render(
      <MemoryRouter>
        <DiffCommentChips runId="r1" comments={[guest, { ...guest, id: 'g2', author: 'Piotr', fresh: true }, base]} onRemove={vi.fn()} />
      </MemoryRouter>,
    )
    const badges = [...document.querySelectorAll('[data-slot="guest-comment-new"]')]
    expect(badges.map((badge) => badge.textContent)).toEqual(['new'])
    expect(badges[0]!.closest('[data-slot="diff-comment-chip"]')?.textContent).toContain('Piotr')
    // Spoken too: the link's label replaces its text, so the badge is the link's description.
    const held = screen.getByRole('link', { name: 'Comment from Piotr on http://localhost:5173/settings element Save' })
    expect(held.getAttribute('aria-describedby')).toBe(badges[0]!.id)
    expect(badges[0]!.getAttribute('aria-label')).toBe('New: a review sent now leaves it behind')
    expect(screen.getByRole('link', { name: 'Comment from Ana on http://localhost:5173/settings element Save' }).hasAttribute('aria-describedby')).toBe(false)
  })

  it('badges a comment that already went to the agent but is still listed, and keeps its ✕', () => {
    const onRemove = vi.fn()
    render(
      <MemoryRouter>
        <DiffCommentChips runId="r1" comments={[{ ...guest, sent: true }, { ...guest, id: 'g2', author: 'Piotr' }]} onRemove={onRemove} />
      </MemoryRouter>,
    )
    const badges = [...document.querySelectorAll('[data-slot="guest-comment-sent"]')]
    expect(badges.map((badge) => badge.textContent)).toEqual(['sent'])
    expect(document.querySelector('[data-slot="guest-comment-new"]')).toBeNull()
    const link = screen.getByRole('link', { name: 'Comment from Ana on http://localhost:5173/settings element Save' })
    expect(link.getAttribute('aria-describedby')).toBe(badges[0]!.id)
    expect(badges[0]!.getAttribute('aria-label')).toBe('Sent: the agent already has it')
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment from Ana on element Save' }))
    expect(onRemove).toHaveBeenCalledWith('g1')
  })

  it('with the workspace callback, a click opens the Preview on the stored address and does not navigate', () => {
    const onOpenInPreview = vi.fn()
    const asset = { kind: 'asset' as const, id: 'e', asset: 'mock/recipe.html', selector: 'main > h2', label: '', excerpt: '', body: 'b' }
    function Where() {
      return <span data-testid="where">{useLocation().pathname}</span>
    }
    render(
      <MemoryRouter initialEntries={['/tasks/r1']}>
        <DiffCommentChips runId="r1" comments={[base, asset, guest]} onRemove={vi.fn()} onOpenInPreview={onOpenInPreview} />
        <Where />
      </MemoryRouter>,
    )
    const open = screen.getByRole('button', { name: 'Comment from Ana on http://localhost:5173/settings element Save' })
    fireEvent.click(open)
    expect(onOpenInPreview).toHaveBeenCalledTimes(1)
    expect(onOpenInPreview).toHaveBeenCalledWith('http://localhost:5173/settings')
    expect(screen.getByTestId('where').textContent).toBe('/tasks/r1')
    // The diff and asset chips are the links they always were.
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '/tasks/r1/changes?file=src%2Fapp%2Fpage.tsx&side=new&line=11&comment=a',
      '/tasks/r1/assets/mock%2Frecipe.html',
    ])
  })

  describe('the address a chip opens in the Preview', () => {
    const chipFor = (url: string) => {
      const onOpenInPreview = vi.fn()
      render(
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <DiffCommentChips runId="r1" comments={[{ ...guest, url }]} onRemove={vi.fn()} onOpenInPreview={onOpenInPreview} />
        </MemoryRouter>,
      )
      return onOpenInPreview
    }

    it.each([
      'http://localhost:5173/settings',
      'http://127.0.0.1:3000/',
      'http://127.8.9.10/x?y=1#z',
      'http://[::1]:8080/',
    ])('is %s: a local http address opens as it is', (url) => {
      const onOpenInPreview = chipFor(url)
      fireEvent.click(screen.getByRole('button', { name: /^Comment from Ana on / }))
      expect(onOpenInPreview).toHaveBeenCalledWith(url)
    })

    it.each([
      ['a script', 'javascript:boom(document.domain)'],
      ['another site', 'https://evil.example/'],
      ['another site over http', 'http://evil.example/'],
      ['https on this machine', 'https://localhost:5173/'],
      ['a name that only starts like this machine', 'http://localhost.evil.example/'],
      ['an address that only starts like loopback', 'http://127.0.0.1.evil.example/'],
      ['this machine as a user name', 'http://localhost:5173@evil.example/'],
      ['a data page', 'data:text/html,<script>boom(1)</script>'],
      ['not an address', 'settings'],
    ])('is %s: the chip is the plain Preview link and the address goes nowhere', (_label, url) => {
      const onOpenInPreview = chipFor(url)
      expect(screen.queryByRole('button', { name: /^Comment from Ana on / })).toBeNull()
      const link = screen.getByRole('link', { name: /^Comment from Ana on / })
      expect(link.getAttribute('href')).toBe('/tasks/r1/preview')
      fireEvent.click(link)
      expect(onOpenInPreview).not.toHaveBeenCalled()
      expect(document.body.innerHTML).not.toContain(`href="${url}"`)
    })
  })

  // F1: the owner can only gate what they can see — every field the agent reads must be on both
  // owner surfaces (the chip's tooltip before sending, the card after).
  const MARKED: GuestReviewComment = {
    kind: 'guest',
    id: 'MARKid',
    revision: 7,
    author: 'MARKauthor',
    createdAt: 'MARKcreatedAt',
    url: 'http://localhost:5173/MARKurl',
    selector: 'main > button.MARKselector',
    label: 'MARKlabel',
    excerpt: '<b>MARKexcerpt</b>',
    component: 'MARKcomponent',
    body: [...Array.from({ length: 39 }, (_, i) => `line ${i + 1}`), 'MARKbody'].join('\n'),
  }
  const marked = (text: string) =>
    Object.keys(MARKED)
      .filter((key) => text.includes(`MARK${key}`))
      .sort()

  async function tooltipText(comment: GuestReviewComment): Promise<Element> {
    // Radix positions the tooltip with floating-ui, which measures — jsdom has no observer.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    render(
      <MemoryRouter>
        <DiffCommentChips runId="r1" comments={[comment]} onRemove={vi.fn()} />
      </MemoryRouter>,
    )
    fireEvent.focus(screen.getByRole('link'))
    const tooltip = await waitFor(() => {
      const found = document.querySelector('[data-slot="diff-comment-tooltip"]')
      expect(found).not.toBeNull()
      return found!
    })
    vi.unstubAllGlobals()
    return tooltip
  }

  it('shows in the tooltip everything the agent will read, the whole body unclamped', async () => {
    const tooltip = await tooltipText(MARKED)
    for (const text of ['MARKurl', 'MARKselector', 'MARKlabel', 'MARKcomponent', 'MARKexcerpt', 'MARKbody', 'MARKauthor']) {
      expect(tooltip.textContent).toContain(text)
    }
    expect(tooltip.querySelector('[class*="line-clamp"]')).toBeNull()
    expect(tooltip.querySelector('[data-slot="guest-comment-excerpt"]')?.tagName).toBe('PRE')
  })

  it('shows no bidi control on the chip or in its tooltip: the owner reads the order the agent gets', async () => {
    const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((code) => String.fromCodePoint(code))
    const laced = (text: string) => BIDI.map((mark) => `${mark}${text}`).join('') + BIDI.join('')
    const tooltip = await tooltipText({
      ...MARKED,
      author: laced('A'),
      url: `http://localhost:5173/${laced('u')}`,
      selector: `main > ${laced('s')}`,
      label: laced('l'),
      component: laced('c'),
      excerpt: laced('e'),
      body: laced('b'),
    })
    const chip = document.querySelector('[data-slot="diff-comment-chip"]')!
    for (const mark of BIDI) {
      expect(tooltip.textContent).not.toContain(mark)
      expect(chip.textContent).not.toContain(mark)
      expect(chip.innerHTML).not.toContain(mark)
    }
    expect(tooltip.textContent).toContain('b'.repeat(12))
    expect(tooltip.textContent).toContain('e'.repeat(12))
    expect(chip.textContent).toContain(`${'A'.repeat(12)} · ${'s'.repeat(12)} “${'l'.repeat(12)}”`)
  })

  it('every field the formatter sends is on the tooltip and on the card, and no other', async () => {
    const sentFields = marked(formatDiffComments([MARKED]))
    expect(sentFields).toEqual(['author', 'body', 'component', 'excerpt', 'label', 'selector', 'url'])
    const tooltip = await tooltipText(MARKED)
    expect(marked(tooltip.textContent ?? '')).toEqual(sentFields)
    cleanup()
    render(
      <MemoryRouter>
        <ReviewCommentsBlock items={parseReviewMessage(formatDiffComments([MARKED]))!.items} />
      </MemoryRouter>,
    )
    const card = document.querySelector('[data-slot="review-comment"]')!
    expect(marked(card.textContent ?? '')).toEqual(sentFields)
  })

  it('drops the label part when there is none, and renders hostile text as text', () => {
    render(
      <MemoryRouter>
        <DiffCommentChips
          runId="r1"
          comments={[{ ...guest, label: '', author: '<img src=x onerror=boom(1)>' }]}
          onRemove={vi.fn()}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText('<img src=x onerror=boom(1)> · button.btn-primary')).not.toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })
})
