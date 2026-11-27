import {
  guestCommentParamSchema,
  guestCommentsSentRequestSchema,
  previewShareDecisionSchema,
  previewShareGuestParamSchema,
  previewShareRequestSchema,
  runIdParamSchema,
  type GuestComment,
  type GuestCommentsEvent,
  type PreviewShare,
  type PreviewShareError,
  type PreviewShareEvent,
} from '@open-mercato/cezar-contract';
import { Hono } from 'hono';

import { deleteGuestComment, readGuestComments, removeSentGuestComments, toGuestComment } from '../runs/guest-comments.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { PreviewShares } from './preview/share-listener.ts';
import type { ProjectContext } from './project-context.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';

/**
 * The cockpit's side of Preview Share (spec 2026-11-26-preview-share-link § API and contract).
 * `share.url` carries the link token: it leaves only in these answers and the two SSE frames.
 */

type ProjectApiEnv = { Variables: { project: ProjectContext } };

export interface PreviewShareRouteDeps {
  shares: PreviewShares;
  /** `capabilities().previewShare`, read per request: a hosted cockpit and a paired phone get `false`. */
  enabled(): boolean;
  /** The registry id a share is listed and found again under; the boot context's `id` is not it. */
  projectId(project: ProjectContext): Promise<string>;
}

export interface PreviewShareBusPayload {
  runId: string;
  share: PreviewShare | null;
  ended?: string;
}

export interface GuestCommentsBusPayload {
  runId: string;
  comments: GuestComment[];
}

/** The reason a share carries when its task is archived, deleted or loses its worktree. */
export const TASK_REMOVED = 'the task was removed';
// Every 409 is typed as the contract's shape: TypeScript folds a union of object literals into
// its widest member, which would erase `code` and `install` from the route type.
const OFF: PreviewShareError = { error: 'Sharing is not available on this cockpit' };
const ARCHIVED: PreviewShareError = { error: 'An archived task cannot be shared' };

export function previewShareFrame(payload: PreviewShareBusPayload, project?: string): PreviewShareEvent {
  return {
    type: 'preview-share',
    runId: payload.runId,
    share: payload.share,
    ...(payload.ended !== undefined ? { ended: payload.ended } : {}),
    ...(project !== undefined ? { project } : {}),
  };
}

export function guestCommentsFrame(payload: GuestCommentsBusPayload, project?: string): GuestCommentsEvent {
  return {
    type: 'guest-comments',
    runId: payload.runId,
    comments: payload.comments,
    ...(project !== undefined ? { project } : {}),
  };
}

/** Both live frames of one store, so neither SSE endpoint can forward one without the other. */
export function onPreviewShareFrames(
  store: RunStore,
  send: (event: 'preview-share' | 'guest-comments', frame: PreviewShareEvent | GuestCommentsEvent) => void,
  project?: string,
): () => void {
  const onShare = (payload: PreviewShareBusPayload): void => send('preview-share', previewShareFrame(payload, project));
  const onComments = (payload: GuestCommentsBusPayload): void => send('guest-comments', guestCommentsFrame(payload, project));
  store.on('preview-share', onShare);
  store.on('guest-comments', onComments);
  return () => {
    store.off('preview-share', onShare);
    store.off('guest-comments', onComments);
  };
}

/**
 * Calls `removed` when a task goes away by any path (spec 2026-11-26-preview-share-link § States):
 * deleted, archived, or its worktree reclaimed or removed. The store is the one place every path
 * writes, the retention sweeps and deferred lifecycle operations included.
 */
export function onTaskRemoved(store: RunStore, removed: (runId: string) => void): () => void {
  // Only a tree that was there and is gone is a removal: a task that never had one stays shareable.
  const hasTree = (run: RunRecord): boolean => !!run.worktreePath && run.worktreeReclaimedAt === undefined;
  const trees = new Set(store.listRuns().filter(hasTree).map((run) => run.id));
  const onRun = (run: RunRecord): void => {
    const lost = trees.has(run.id) && !hasTree(run);
    if (hasTree(run)) trees.add(run.id);
    else trees.delete(run.id);
    if (lost || run.archived) removed(run.id);
  };
  const onDeleted = (runId: string): void => {
    trees.delete(runId);
    removed(runId);
  };
  store.on('run', onRun);
  store.on('deleted', onDeleted);
  return () => {
    store.off('run', onRun);
    store.off('deleted', onDeleted);
  };
}

function listed(project: ProjectContext, runId: string): GuestComment[] {
  return readGuestComments(project.dataDir, runId).map(toGuestComment);
}

/** Every open cockpit reads the list again from this, whoever changed it. */
export function publishGuestCommentList(project: ProjectContext, runId: string): void {
  project.store.publishGuestComments(runId, listed(project, runId));
}

/**
 * Project-scoped. Starting a share and steering its guests need the capability; reading, stopping
 * and the comment routes do not, so a live link can always be ended and what was left stays usable.
 */
export function previewShareRoutes(deps: PreviewShareRouteDeps) {
  const { shares } = deps;
  return new Hono<ProjectApiEnv>()
    .post('/runs/:id/preview-share', jsonZodValidator(previewShareRequestSchema), async (c) => {
      if (!deps.enabled()) return c.json(OFF, 409);
      const project = c.get('project');
      const id = c.req.param('id');
      const projectId = await deps.projectId(project);
      // Nothing is awaited between these checks and `start`, which decides before its own first await.
      const run = project.store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (run.archived) return c.json(ARCHIVED, 409);
      const host = c.req.header('host');
      const started = await shares.start({ ...c.req.valid('json'), runId: id, projectId, forbidden: host ? [`http://${host}`] : [] });
      if (started.ok) return c.json({ share: started.share }, 200);
      if (started.status === 400) return c.json({ error: started.error }, 400);
      const refused: PreviewShareError = {
        error: started.error,
        ...(started.code !== undefined ? { code: started.code } : {}),
        ...(started.install !== undefined ? { install: started.install } : {}),
      };
      return c.json(refused, 409);
    })

    .get('/runs/:id/preview-share', (c) => c.json({ share: shares.get(c.req.param('id')) }))

    // Idempotent, and also cancels a start still waiting on its tunnel.
    .delete('/runs/:id/preview-share', (c) => {
      const id = c.req.param('id');
      shares.stop(id);
      return c.json({ share: shares.get(id) });
    })

    // Gated: it prolongs the exposure (spec 2026-11-26-preview-share-link C5).
    .post('/runs/:id/preview-share/extend', paramZodValidator(runIdParamSchema), (c) => {
      if (!deps.enabled()) return c.json(OFF, 409);
      const share = shares.extend(c.req.valid('param').id);
      if (share === null) return c.json({ error: 'This task is not sharing' }, 404);
      return c.json({ share }, 200);
    })

    .post('/runs/:id/preview-share/guests/:guestId', paramZodValidator(previewShareGuestParamSchema), jsonZodValidator(previewShareDecisionSchema), (c) => {
      if (!deps.enabled()) return c.json(OFF, 409);
      const { id, guestId } = c.req.valid('param');
      if (!shares.decide(id, guestId, c.req.valid('json').decision)) return c.json({ error: 'That visitor is no longer waiting' }, 404);
      return c.json({ share: shares.get(id) }, 200);
    })

    .delete('/runs/:id/preview-share/guests/:guestId', paramZodValidator(previewShareGuestParamSchema), (c) => {
      if (!deps.enabled()) return c.json(OFF, 409);
      const { id, guestId } = c.req.valid('param');
      if (!shares.removeGuest(id, guestId)) return c.json({ error: 'That visitor is not on this link' }, 404);
      return c.json({ share: shares.get(id) }, 200);
    })

    .get('/runs/:id/guest-comments', (c) => c.json({ comments: listed(c.get('project'), c.req.param('id')) }))

    .delete('/runs/:id/guest-comments/:commentId', paramZodValidator(guestCommentParamSchema), (c) => {
      const project = c.get('project');
      const { id, commentId } = c.req.valid('param');
      // No guest id: the owner may delete any comment.
      const removed = deleteGuestComment(project.dataDir, id, commentId);
      const comments = listed(project, id);
      if (removed) project.store.publishGuestComments(id, comments);
      return c.json({ comments });
    })

    .post('/runs/:id/guest-comments/sent', jsonZodValidator(guestCommentsSentRequestSchema), (c) => {
      const project = c.get('project');
      const id = c.req.param('id');
      const removed = removeSentGuestComments(project.dataDir, id, c.req.valid('json').comments);
      if (removed.length > 0) publishGuestCommentList(project, id);
      return c.json({ removed });
    });
}

/** Workspace-level and single-mount (C7). No `url`: this listing is for badges, never for the link. */
export function liveShareRoutes(deps: { shares: PreviewShares; title(projectId: string, runId: string): string }) {
  return new Hono().get('/workspace/preview-shares', (c) =>
    c.json({
      shares: deps.shares.list().map(({ projectId, share }) => ({
        projectId,
        runId: share.runId,
        title: deps.title(projectId, share.runId),
        target: share.target,
        expiresAt: share.expiresAt,
        waiting: share.guests.filter((guest) => guest.state === 'waiting').length,
      })),
    }),
  );
}
