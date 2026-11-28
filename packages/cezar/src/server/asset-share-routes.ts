import {
  assetShareDecisionSchema,
  assetShareGuestParamSchema,
  assetShareRequestSchema,
  guestCommentParamSchema,
  guestCommentsSentRequestSchema,
  runIdParamSchema,
  type AssetShare,
  type AssetShareError,
  type AssetShareEvent,
  type GuestComment,
  type GuestCommentsEvent,
} from '@open-mercato/cezar-contract';
import { Hono } from 'hono';

import { findArtifact, scanArtifacts } from '../runs/artifacts.ts';
import { deleteGuestComment, readGuestComments, removeSentGuestComments, toGuestComment } from '../runs/guest-comments.ts';
import { artifactsDir, type RunRecord, type RunStore } from '../runs/store.ts';
import type { AssetShares } from './preview/share-listener.ts';
import type { ProjectContext } from './project-context.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';

/**
 * The cockpit's side of Asset Share (spec 2026-11-28-asset-share-link § API and contract).
 * `share.url` carries the link token: it leaves only in these answers and the two SSE frames.
 */

type ProjectApiEnv = { Variables: { project: ProjectContext } };

export interface AssetShareRouteDeps {
  shares: AssetShares;
  /** `capabilities().assetShare`, read per request: a hosted cockpit and a paired phone get `false`. */
  enabled(): boolean;
  /** The registry id a share is listed and found again under; the boot context's `id` is not it. */
  projectId(project: ProjectContext): Promise<string>;
}

export interface AssetShareBusPayload {
  runId: string;
  share: AssetShare | null;
  ended?: string;
}

export interface GuestCommentsBusPayload {
  runId: string;
  comments: GuestComment[];
}

/** The reason a share carries when its task is archived or deleted. */
export const TASK_REMOVED = 'the task was removed';
// Every 409 is typed as the contract's shape: TypeScript folds a union of object literals into
// its widest member, which would erase `code` and `install` from the route type.
const OFF: AssetShareError = { error: 'Sharing is not available on this cockpit' };
const ARCHIVED: AssetShareError = { error: 'An archived task cannot be shared' };
const NOT_HTML = 'Only an HTML asset of this task can be shared';

export function assetShareFrame(payload: AssetShareBusPayload, project?: string): AssetShareEvent {
  return {
    type: 'asset-share',
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
export function onAssetShareFrames(
  store: RunStore,
  send: (event: 'asset-share' | 'guest-comments', frame: AssetShareEvent | GuestCommentsEvent) => void,
  project?: string,
): () => void {
  const onShare = (payload: AssetShareBusPayload): void => send('asset-share', assetShareFrame(payload, project));
  const onComments = (payload: GuestCommentsBusPayload): void => send('guest-comments', guestCommentsFrame(payload, project));
  store.on('asset-share', onShare);
  store.on('guest-comments', onComments);
  return () => {
    store.off('asset-share', onShare);
    store.off('guest-comments', onComments);
  };
}

/**
 * Calls `removed` when a task goes away (spec 2026-11-28-asset-share-link § States): deleted or
 * archived, by any path — the store is the one place every path writes, the retention sweeps and
 * deferred lifecycle operations included. A reclaimed worktree is not a removal: assets live
 * under the data directory, not in the worktree.
 */
export function onTaskRemoved(store: RunStore, removed: (runId: string) => void): () => void {
  const onRun = (run: RunRecord): void => {
    if (run.archived) removed(run.id);
  };
  const onDeleted = (runId: string): void => removed(runId);
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
export function assetShareRoutes(deps: AssetShareRouteDeps) {
  const { shares } = deps;
  // A share is found by run id alone, and `/p/<another project>/runs/<this run>/…` reaches these
  // handlers too: every one that reads or steers a share first asks whose it is.
  const mine = async (project: ProjectContext, runId: string): Promise<boolean> => {
    const asking = await deps.projectId(project);
    // Nothing is awaited between this answer and the handler's own call on the share.
    return shares.projectOf(runId) === asking;
  };
  return new Hono<ProjectApiEnv>()
    .post('/runs/:id/asset-share', jsonZodValidator(assetShareRequestSchema), async (c) => {
      if (!deps.enabled()) return c.json(OFF, 409);
      const project = c.get('project');
      const id = c.req.param('id');
      const { asset } = c.req.valid('json');
      const projectId = await deps.projectId(project);
      if (!project.store.getRun(id)) return c.json({ error: 'not found' }, 404);
      // `findArtifact` is the traversal guard; only a page can be explored and commented on.
      const dir = artifactsDir(project.dataDir, id);
      const found = await findArtifact(dir, asset);
      if (found === null || found.kind !== 'html') return c.json({ error: NOT_HTML }, 400);
      const assetTitle = (await scanArtifacts(dir)).artifacts.find((listed) => listed.name === asset)?.title ?? asset;
      // Nothing is awaited between these checks and `start`, which decides before its own first await.
      const run = project.store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (run.archived) return c.json(ARCHIVED, 409);
      const started = await shares.start({ runId: id, projectId, asset, assetTitle });
      if (started.ok) return c.json({ share: started.share }, 200);
      const refused: AssetShareError = {
        error: started.error,
        ...(started.code !== undefined ? { code: started.code } : {}),
        ...(started.install !== undefined ? { install: started.install } : {}),
      };
      return c.json(refused, 409);
    })

    .get('/runs/:id/asset-share', async (c) => {
      const id = c.req.param('id');
      return c.json({ share: (await mine(c.get('project'), id)) ? shares.get(id) : null });
    })

    // Idempotent, and also cancels a start still waiting on its tunnel.
    .delete('/runs/:id/asset-share', async (c) => {
      const id = c.req.param('id');
      if (!(await mine(c.get('project'), id))) return c.json({ share: null });
      shares.stop(id);
      return c.json({ share: shares.get(id) });
    })

    // Gated: it prolongs the exposure (spec 2026-11-28-asset-share-link C5).
    .post('/runs/:id/asset-share/extend', paramZodValidator(runIdParamSchema), async (c) => {
      if (!deps.enabled()) return c.json(OFF, 409);
      const { id } = c.req.valid('param');
      const share = (await mine(c.get('project'), id)) ? shares.extend(id) : null;
      if (share === null) return c.json({ error: 'This task is not sharing' }, 404);
      return c.json({ share }, 200);
    })

    .post('/runs/:id/asset-share/guests/:guestId', paramZodValidator(assetShareGuestParamSchema), jsonZodValidator(assetShareDecisionSchema), async (c) => {
      if (!deps.enabled()) return c.json(OFF, 409);
      const { id, guestId } = c.req.valid('param');
      const decided = (await mine(c.get('project'), id)) && shares.decide(id, guestId, c.req.valid('json').decision);
      if (!decided) return c.json({ error: 'That visitor is no longer waiting' }, 404);
      return c.json({ share: shares.get(id) }, 200);
    })

    .delete('/runs/:id/asset-share/guests/:guestId', paramZodValidator(assetShareGuestParamSchema), async (c) => {
      if (!deps.enabled()) return c.json(OFF, 409);
      const { id, guestId } = c.req.valid('param');
      const removed = (await mine(c.get('project'), id)) && shares.removeGuest(id, guestId);
      if (!removed) return c.json({ error: 'That visitor is not on this link' }, 404);
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
export function liveShareRoutes(deps: { shares: AssetShares; title(projectId: string, runId: string): string }) {
  return new Hono().get('/workspace/asset-shares', (c) =>
    c.json({
      shares: deps.shares.list().map(({ projectId, share }) => ({
        projectId,
        runId: share.runId,
        title: deps.title(projectId, share.runId),
        asset: share.asset,
        assetTitle: share.assetTitle,
        expiresAt: share.expiresAt,
        waiting: share.guests.filter((guest) => guest.state === 'waiting').length,
      })),
    }),
  );
}
