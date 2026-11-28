import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GUEST_COMMENT_LINE_COST,
  GUEST_COMMENT_OVERHEAD,
  GUEST_COMMENTS_MAX,
  GUEST_COMMENTS_TEXT_BUDGET,
} from '@open-mercato/cezar-contract';
import {
  addGuestComment,
  deleteGuestComment,
  deleteRunGuestComments,
  guestCommentsRoot,
  readGuestComments,
  removeSentGuestComments,
  toGuestComment,
  updateGuestComment,
} from './guest-comments.ts';

const pick = { asset: 'settings-mockup.html', selector: 'main > button', label: 'Save', excerpt: 'Save' };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-guest-comments-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function add(body: string, guestId = 'g1', runId = 'r1') {
  const r = addGuestComment(dir, runId, { ...pick, body, author: 'Ana', guestId });
  if (!r.ok) throw new Error(`add refused: ${r.reason}`);
  return r.comment;
}
/** What a comment with no line break and no backtick is charged: its text and the fixed overhead. */
const size = (c: { body: string; excerpt: string; label: string; selector: string; asset: string; component?: string }) =>
  c.body.length + c.excerpt.length + c.label.length + c.selector.length + c.asset.length + (c.component?.length ?? 0) + GUEST_COMMENT_OVERHEAD;
/** How many comments of `charge` the budget holds. */
const fits = (charge: number) => Math.floor(GUEST_COMMENTS_TEXT_BUDGET / charge);

describe('guest comments', () => {
  it('adds, lists and bumps the revision on an edit', () => {
    const a = addGuestComment(dir, 'r1', { ...pick, body: 'first', author: 'Ana', guestId: 'g1' });
    expect(a.ok && a.comment.revision).toBe(1);
    if (!a.ok) return;
    const b = updateGuestComment(dir, 'r1', a.comment.id, 'g1', 'second');
    expect(b.ok && b.comment.revision).toBe(2);
    expect(readGuestComments(dir, 'r1').map((c) => c.body)).toEqual(['second']);
  });

  it('keeps guestId on disk and drops it from the public shape', () => {
    const c = add('hi');
    expect(readGuestComments(dir, 'r1')[0]?.guestId).toBe('g1');
    expect('guestId' in toGuestComment(c)).toBe(false);
  });

  it("refuses another guest's edit and delete", () => {
    const { id } = add('mine');
    expect(updateGuestComment(dir, 'r1', id, 'g2', 'x')).toEqual({ ok: false, reason: 'not-found' });
    expect(deleteGuestComment(dir, 'r1', id, 'g2')).toBe(false);
    expect(readGuestComments(dir, 'r1')).toHaveLength(1);
    expect(deleteGuestComment(dir, 'r1', id)).toBe(true); // the owner
    expect(readGuestComments(dir, 'r1')).toEqual([]);
  });

  it('removes a sent comment only at the revision that was sent', () => {
    const c1 = add('one').id;
    const c2 = add('two').id;
    updateGuestComment(dir, 'r1', c2, 'g1', 'two, edited');
    expect(removeSentGuestComments(dir, 'r1', [{ id: c1, revision: 1 }, { id: c2, revision: 1 }])).toEqual([c1]);
    expect(readGuestComments(dir, 'r1').map((c) => c.id)).toEqual([c2]);
  });

  it('stops at 50 comments', () => {
    for (let i = 0; i < GUEST_COMMENTS_MAX; i++) add(`c${i}`);
    expect(addGuestComment(dir, 'r1', { ...pick, body: 'one more', author: 'Ana', guestId: 'g1' })).toEqual({
      ok: false,
      reason: 'full',
    });
    expect(readGuestComments(dir, 'r1')).toHaveLength(GUEST_COMMENTS_MAX);
  });

  it('stops at the character budget, counting every text field', () => {
    const body = 'x'.repeat(2000);
    const per = size({ ...pick, body });
    let total = 0;
    let n = 0;
    while (total + per <= GUEST_COMMENTS_TEXT_BUDGET) {
      add(body);
      total += per;
      n += 1;
    }
    expect(n).toBeGreaterThan(0);
    expect(readGuestComments(dir, 'r1')).toHaveLength(n);
    expect(addGuestComment(dir, 'r1', { ...pick, body, author: 'Ana', guestId: 'g1' })).toEqual({
      ok: false,
      reason: 'budget',
    });
    expect(readGuestComments(dir, 'r1')).toHaveLength(n);
  });

  it('charges 200 characters for each comment on top of its text', () => {
    expect(GUEST_COMMENT_OVERHEAD).toBe(200);
    const body = 'x'.repeat(2000);
    // 2,043 characters of text each: 29 would fit by text alone, 26 with the item's structure.
    expect(fits(2043)).toBe(29);
    expect(fits(size({ ...pick, body }))).toBe(26);
    for (let i = 0; i < 26; i++) add(body);
    expect(addGuestComment(dir, 'r1', { ...pick, body, author: 'Ana', guestId: 'g1' })).toEqual({ ok: false, reason: 'budget' });
    expect(readGuestComments(dir, 'r1')).toHaveLength(26);
  });

  it.each([
    ['\\n', '\n', 1],
    ['\\r\\n, as one break', '\r\n', 2],
    ['\\r', '\r', 1],
    ['a vertical tab', '\v', 1],
    ['a form feed', '\f', 1],
    ['U+0085', '\u0085', 1],
    ['U+2028', '\u2028', 1],
    ['U+2029', '\u2029', 1],
  ])('charges a body line break of %s as 3 characters', (_label, lineBreak, width) => {
    expect(GUEST_COMMENT_LINE_COST).toBe(3);
    // 2,000 characters, almost all of them breaks: the review indents every line it starts.
    const breaks = Math.floor(1998 / width);
    const body = `a${lineBreak.repeat(breaks)}b`;
    const charge = size({ ...pick, body: '' }) + 2 + 3 * breaks;
    const n = fits(charge);
    // Raw characters alone would let 29 of these in.
    expect(n).toBeLessThan(fits(size({ ...pick, body })));
    for (let i = 0; i < n; i++) add(body);
    expect(addGuestComment(dir, 'r1', { ...pick, body, author: 'Ana', guestId: 'g1' })).toEqual({ ok: false, reason: 'budget' });
    expect(readGuestComments(dir, 'r1')).toHaveLength(n);
    // What is left over still takes a comment that fits it exactly, and not one character more.
    const room = GUEST_COMMENTS_TEXT_BUDGET - n * charge - size({ ...pick, body: '' });
    expect(room).toBeGreaterThan(1);
    expect(addGuestComment(dir, 'r1', { ...pick, body: 'x'.repeat(room + 1), author: 'Ana', guestId: 'g1' })).toEqual({ ok: false, reason: 'budget' });
    expect(addGuestComment(dir, 'r1', { ...pick, body: 'x'.repeat(room), author: 'Ana', guestId: 'g1' }).ok).toBe(true);
  });

  it('charges a line break and a backtick of the excerpt as 3 characters each', () => {
    // The review fences the excerpt with a run one longer than its longest, above and below.
    const body = 'x'.repeat(1000);
    for (const [excerpt, plain, costly, n] of [
      ['a\n'.repeat(300), 300, 300, 24],
      ['`'.repeat(600), 0, 600, 19],
      ['<b>\r\n'.repeat(100), 300, 100, 32],
    ] as const) {
      const run = `r-${n}`;
      expect(fits(size({ ...pick, excerpt: '', body }) + plain + 3 * costly)).toBe(n);
      for (let i = 0; i < n; i++) expect(addGuestComment(dir, run, { ...pick, excerpt, body, author: 'Ana', guestId: 'g1' }).ok).toBe(true);
      expect(addGuestComment(dir, run, { ...pick, excerpt, body, author: 'Ana', guestId: 'g1' })).toEqual({ ok: false, reason: 'budget' });
    }
  });

  it('charges an edit that adds line breaks by the same rule', () => {
    const body = `a${'\n'.repeat(1998)}b`;
    const charge = size({ ...pick, body: '' }) + 2 + 3 * 1998;
    const n = fits(charge);
    for (let i = 0; i < n; i++) add(body);
    const small = add('s');
    expect(updateGuestComment(dir, 'r1', small.id, 'g1', body)).toEqual({ ok: false, reason: 'budget' });
    expect(readGuestComments(dir, 'r1').find((c) => c.id === small.id)?.body).toBe('s');
  });

  it('refuses an edit that would pass the budget and changes nothing', () => {
    const big = 'x'.repeat(2000);
    let total = 0;
    while (total + size({ ...pick, body: big }) <= GUEST_COMMENTS_TEXT_BUDGET) {
      add(big);
      total += size({ ...pick, body: big });
    }
    const small = add('s');
    const room = GUEST_COMMENTS_TEXT_BUDGET - total - size(small);
    // `room` more characters still fit; one beyond must not.
    const fits = updateGuestComment(dir, 'r1', small.id, 'g1', 's'.repeat(1 + room));
    expect(fits.ok).toBe(true);
    const over = updateGuestComment(dir, 'r1', small.id, 'g1', 's'.repeat(2 + room));
    expect(over).toEqual({ ok: false, reason: 'budget' });
    const kept = readGuestComments(dir, 'r1').find((c) => c.id === small.id);
    expect(kept?.body).toBe('s'.repeat(1 + room));
    expect(kept?.revision).toBe(2);
  });

  it('reads a corrupt file as empty and refuses a runId that is not a path segment', () => {
    expect(readGuestComments(dir, '../x')).toEqual([]);
    expect(addGuestComment(dir, '../x', { ...pick, body: 'b', author: 'A', guestId: 'g' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    mkdirSync(guestCommentsRoot(dir), { recursive: true });
    writeFileSync(join(guestCommentsRoot(dir), 'r1.json'), '{not json');
    expect(readGuestComments(dir, 'r1')).toEqual([]);
    expect(add('after corrupt').body).toBe('after corrupt');
  });

  it('keeps the good rows of a file with a bad one, through the next write too', () => {
    const first = add('first');
    const second = add('second');
    const path = join(guestCommentsRoot(dir), 'r1.json');
    const rows = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
    // One row over a cap, one of another shape, one that is not a row at all.
    const bad = [{ ...first, id: 'long', label: 'x'.repeat(81) }, { id: 'bare' }, null, 'junk'];
    writeFileSync(path, JSON.stringify([rows[0], ...bad.slice(0, 2), rows[1], ...bad.slice(2)]));

    expect(readGuestComments(dir, 'r1').map((c) => c.id)).toEqual([first.id, second.id]);
    const third = add('third');
    expect(readGuestComments(dir, 'r1').map((c) => c.body)).toEqual(['first', 'second', 'third']);
    expect(updateGuestComment(dir, 'r1', first.id, 'g1', 'first, edited').ok).toBe(true);
    expect(removeSentGuestComments(dir, 'r1', [{ id: second.id, revision: 1 }])).toEqual([second.id]);
    expect(deleteGuestComment(dir, 'r1', third.id)).toBe(true);
    expect(readGuestComments(dir, 'r1').map((c) => c.body)).toEqual(['first, edited']);
  });

  it('reads a file that is not a list as empty', () => {
    mkdirSync(guestCommentsRoot(dir), { recursive: true });
    writeFileSync(join(guestCommentsRoot(dir), 'r1.json'), JSON.stringify({ comments: [] }));
    expect(readGuestComments(dir, 'r1')).toEqual([]);
  });

  it('deletes a run’s list', () => {
    add('a');
    deleteRunGuestComments(dir, 'r1');
    expect(readGuestComments(dir, 'r1')).toEqual([]);
  });
});
