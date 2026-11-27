import { z } from 'zod';

/**
 * Preview Share (spec `.ai/specs/2026-11-26-preview-share-link.md`): a public link to the task's
 * app, plus the comments a guest leaves on it for the agent.
 */

export const GUEST_COMMENT_BODY_MAX = 2000;
export const GUEST_EXCERPT_MAX = 600;
export const GUEST_NAME_MAX = 60;
export const GUEST_LABEL_MAX = 80;
export const GUEST_SELECTOR_MAX = 1000;
export const GUEST_URL_MAX = 2000;
export const GUEST_COMPONENT_MAX = 300;
export const GUEST_COMMENTS_MAX = 50;
export const GUEST_COMMENTS_TEXT_BUDGET = 60_000;

/** What a guest posts. Every string is capped: it comes from a page the cockpit does not control. */
export const guestCommentInputSchema = z.object({
  url: z.string().min(1).max(GUEST_URL_MAX),
  selector: z.string().min(1).max(GUEST_SELECTOR_MAX),
  label: z.string().max(GUEST_LABEL_MAX),
  excerpt: z.string().max(GUEST_EXCERPT_MAX),
  component: z.string().max(GUEST_COMPONENT_MAX).optional(),
  body: z.string().trim().min(1).max(GUEST_COMMENT_BODY_MAX),
});
export type GuestCommentInput = z.infer<typeof guestCommentInputSchema>;

/** What the cockpit reads. `url` is the app's real address, never the tunnel's. */
export const guestCommentSchema = guestCommentInputSchema.extend({
  id: z.string(),
  revision: z.number().int().positive(),
  author: z.string(),
  createdAt: z.string(),
});
export type GuestComment = z.infer<typeof guestCommentSchema>;

export const guestCommentsResponseSchema = z.object({ comments: z.array(guestCommentSchema) });
export type GuestCommentsResponse = z.infer<typeof guestCommentsResponseSchema>;

export const guestCommentsSentRequestSchema = z.object({
  comments: z
    .array(z.object({ id: z.string(), revision: z.number().int().positive() }))
    .max(GUEST_COMMENTS_MAX),
});
export type GuestCommentsSentRequest = z.infer<typeof guestCommentsSentRequestSchema>;

export const guestCommentsSentResponseSchema = z.object({ removed: z.array(z.string()) });
export type GuestCommentsSentResponse = z.infer<typeof guestCommentsSentResponseSchema>;

/** `id` is the PUBLIC guest id (16 hex), never the cookie's secret. */
export const previewShareGuestSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().regex(/^\d{4}$/),
  state: z.enum(['waiting', 'allowed']),
  requestedAt: z.string(),
});
export type PreviewShareGuest = z.infer<typeof previewShareGuestSchema>;

export const previewShareSchema = z.object({
  runId: z.string(),
  target: z.string(),
  url: z.string(),
  startedAt: z.string(),
  expiresAt: z.string(),
  guests: z.array(previewShareGuestSchema),
});
export type PreviewShare = z.infer<typeof previewShareSchema>;

export const previewShareRequestSchema = z.object({
  target: z.string().min(1).max(2048),
  parentOrigin: z.string().min(1).max(512),
});
export type PreviewShareRequest = z.infer<typeof previewShareRequestSchema>;

export const previewShareResponseSchema = z.object({ share: previewShareSchema });
export type PreviewShareResponse = z.infer<typeof previewShareResponseSchema>;

export const previewShareStateResponseSchema = z.object({ share: previewShareSchema.nullable() });
export type PreviewShareStateResponse = z.infer<typeof previewShareStateResponseSchema>;

export const previewShareErrorSchema = z.object({
  error: z.string(),
  code: z.enum(['no-tunnel', 'tunnel-failed']).optional(),
  install: z.string().optional(),
});
export type PreviewShareError = z.infer<typeof previewShareErrorSchema>;

export const previewShareDecisionSchema = z.object({ decision: z.enum(['allow', 'deny']) });
export type PreviewShareDecision = z.infer<typeof previewShareDecisionSchema>;

export const previewShareGuestParamSchema = z.object({
  id: z.string(),
  guestId: z.string().regex(/^[a-f0-9]{16}$/),
});
export const guestCommentParamSchema = z.object({
  id: z.string(),
  commentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

export const liveSharesResponseSchema = z.object({
  shares: z.array(
    z.object({
      projectId: z.string(),
      runId: z.string(),
      title: z.string(),
      target: z.string(),
      expiresAt: z.string(),
      waiting: z.number().int(),
    }),
  ),
});
export type LiveSharesResponse = z.infer<typeof liveSharesResponseSchema>;

/** SSE frame on the global stream; carries the WHOLE current value, like `runArtifactsEventSchema`. */
export const previewShareEventSchema = z.object({
  type: z.literal('preview-share'),
  runId: z.string(),
  project: z.string().optional(),
  share: previewShareSchema.nullable(),
  /** Why the share ended on its own. */
  ended: z.string().optional(),
});
export type PreviewShareEvent = z.infer<typeof previewShareEventSchema>;

export const guestCommentsEventSchema = z.object({
  type: z.literal('guest-comments'),
  runId: z.string(),
  project: z.string().optional(),
  comments: z.array(guestCommentSchema),
});
export type GuestCommentsEvent = z.infer<typeof guestCommentsEventSchema>;
