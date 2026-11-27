import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  GUEST_COMMENTS_MAX,
  GUEST_COMMENTS_TEXT_BUDGET,
  guestCommentCost,
  guestCommentSchema,
  type GuestComment,
  type GuestCommentInput,
} from '@open-mercato/cezar-contract';
import { z } from 'zod';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * The server-owned guest-comment list per run (spec 2026-11-26-preview-share-link § Storage):
 * `<dataDir>/guest-comments/<runId>.json`. Every change is a synchronous read-modify-write, so two
 * requests in one process cannot interleave. Reads never throw; a corrupt file is an empty list.
 */

/** `guestId` is the PUBLIC guest id; it never leaves the server (`toGuestComment`). */
const storedSchema = guestCommentSchema.extend({ guestId: z.string() });
export type StoredGuestComment = z.infer<typeof storedSchema>;

export function guestCommentsRoot(dataDir: string): string {
  return join(dataDir, 'guest-comments');
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function listPath(dataDir: string, runId: string): string | null {
  return RUN_ID_RE.test(runId) ? join(guestCommentsRoot(dataDir), `${runId}.json`) : null;
}

export function readGuestComments(dataDir: string, runId: string): StoredGuestComment[] {
  const path = listPath(dataDir, runId);
  if (path === null) return [];
  try {
    const parsed = z.array(storedSchema).safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function save(dataDir: string, runId: string, list: StoredGuestComment[]): boolean {
  const path = listPath(dataDir, runId);
  if (path === null) return false;
  try {
    atomicWriteJsonSync(path, list);
    return true;
  } catch {
    return false;
  }
}

/** The review message holds 100,000 characters; this is what the list may spend of them. */
const textSize = guestCommentCost;

const total = (list: readonly StoredGuestComment[]): number => list.reduce((n, c) => n + textSize(c), 0);

export type GuestCommentWrite =
  | { ok: true; comment: StoredGuestComment }
  | { ok: false; reason: 'full' | 'budget' | 'not-found' };

export function addGuestComment(
  dataDir: string,
  runId: string,
  input: GuestCommentInput & { author: string; guestId: string },
  now: () => Date = () => new Date(),
): GuestCommentWrite {
  const list = readGuestComments(dataDir, runId);
  if (list.length >= GUEST_COMMENTS_MAX) return { ok: false, reason: 'full' };
  const comment: StoredGuestComment = {
    ...input,
    id: randomUUID(),
    revision: 1,
    createdAt: now().toISOString(),
  };
  if (total(list) + textSize(comment) > GUEST_COMMENTS_TEXT_BUDGET) return { ok: false, reason: 'budget' };
  if (!save(dataDir, runId, [...list, comment])) return { ok: false, reason: 'not-found' };
  return { ok: true, comment };
}

export function updateGuestComment(
  dataDir: string,
  runId: string,
  id: string,
  guestId: string,
  body: string,
): GuestCommentWrite {
  const list = readGuestComments(dataDir, runId);
  const index = list.findIndex((c) => c.id === id && c.guestId === guestId);
  const current = list[index];
  if (current === undefined) return { ok: false, reason: 'not-found' };
  const next: StoredGuestComment = { ...current, body, revision: current.revision + 1 };
  if (total(list) - textSize(current) + textSize(next) > GUEST_COMMENTS_TEXT_BUDGET) {
    return { ok: false, reason: 'budget' };
  }
  const updated = list.map((c, i) => (i === index ? next : c));
  if (!save(dataDir, runId, updated)) return { ok: false, reason: 'not-found' };
  return { ok: true, comment: next };
}

/** `guestId` omitted means the owner, who may delete any comment. */
export function deleteGuestComment(dataDir: string, runId: string, id: string, guestId?: string): boolean {
  const list = readGuestComments(dataDir, runId);
  const kept = list.filter((c) => !(c.id === id && (guestId === undefined || c.guestId === guestId)));
  if (kept.length === list.length) return false;
  return save(dataDir, runId, kept);
}

/** Step 10: a comment edited while the send was in flight has a newer revision and stays. */
export function removeSentGuestComments(
  dataDir: string,
  runId: string,
  sent: readonly { id: string; revision: number }[],
): string[] {
  const list = readGuestComments(dataDir, runId);
  const gone = list.filter((c) => sent.some((s) => s.id === c.id && s.revision === c.revision));
  if (gone.length === 0) return [];
  const goneIds = new Set(gone.map((c) => c.id));
  if (!save(dataDir, runId, list.filter((c) => !goneIds.has(c.id)))) return [];
  return gone.map((c) => c.id);
}

/** Permanent task deletion only: comments outlive a share that ended. */
export function deleteRunGuestComments(dataDir: string, runId: string): void {
  const path = listPath(dataDir, runId);
  if (path === null) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* already gone, or a read-only home */
  }
}

export function toGuestComment(stored: StoredGuestComment): GuestComment {
  const { guestId: _guestId, ...comment } = stored;
  return comment;
}
