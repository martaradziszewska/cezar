import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUEST_COMMENTS_MAX, GUEST_COMMENTS_TEXT_BUDGET } from '@open-mercato/cezar-contract';
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

const pick = { url: 'http://localhost:5173/', selector: 'main > button', label: 'Save', excerpt: 'Save' };
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
const size = (c: { body: string; excerpt: string; label: string; selector: string; url: string; component?: string }) =>
  c.body.length + c.excerpt.length + c.label.length + c.selector.length + c.url.length + (c.component?.length ?? 0);

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

  it('deletes a run’s list', () => {
    add('a');
    deleteRunGuestComments(dir, 'r1');
    expect(readGuestComments(dir, 'r1')).toEqual([]);
  });
});
