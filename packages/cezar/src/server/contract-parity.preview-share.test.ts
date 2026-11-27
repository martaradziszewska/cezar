import { hc, type InferResponseType } from 'hono/client';
import type { ExtractSchema } from 'hono/types';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  guestCommentsResponseSchema,
  guestCommentsSentRequestSchema,
  guestCommentsSentResponseSchema,
  liveSharesResponseSchema,
  previewShareDecisionSchema,
  previewShareErrorSchema,
  previewShareRequestSchema,
  previewShareResponseSchema,
  previewShareStateResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `contract/preview-share.ts` must describe EXACTLY what the Preview Share routes send (spec
 * 2026-11-26-preview-share-link § API and contract). Both directions, compile-time: `npm run
 * typecheck` enforces it.
 */
describe('contract/preview-share.ts matches the preview-share routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Assert<T extends true> = T;

  type Share = typeof client.api.v1.runs[':id']['preview-share'];
  type Guest = Share['guests'][':guestId'];
  type Comments = typeof client.api.v1.runs[':id']['guest-comments'];
  type Live = typeof client.api.v1.workspace['preview-shares'];
  type State = z.infer<typeof previewShareStateResponseSchema>;

  type _Checks = [
    Assert<Mutual<z.infer<typeof previewShareResponseSchema>, InferResponseType<Share['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof previewShareErrorSchema>, InferResponseType<Share['$post'], 409>>>,
    Assert<Mutual<State, InferResponseType<Share['$get'], 200>>>,
    Assert<Mutual<State, InferResponseType<Share['$delete'], 200>>>,
    Assert<Mutual<State, InferResponseType<Guest['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof previewShareErrorSchema>, InferResponseType<Guest['$post'], 409>>>,
    Assert<Mutual<State, InferResponseType<Guest['$delete'], 200>>>,
    Assert<Mutual<z.infer<typeof previewShareErrorSchema>, InferResponseType<Guest['$delete'], 409>>>,
    Assert<Mutual<z.infer<typeof guestCommentsResponseSchema>, InferResponseType<Comments['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof guestCommentsResponseSchema>, InferResponseType<Comments[':commentId']['$delete'], 200>>>,
    Assert<Mutual<z.infer<typeof guestCommentsSentResponseSchema>, InferResponseType<Comments['sent']['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof liveSharesResponseSchema>, InferResponseType<Live['$get'], 200>>>,
  ];

  type Schema = ExtractSchema<AppType>;
  type _Inputs = [
    Assert<Mutual<z.infer<typeof previewShareRequestSchema>, Schema['/api/v1/runs/:id/preview-share']['$post']['input']['json']>>,
    Assert<Mutual<z.infer<typeof previewShareDecisionSchema>, Schema['/api/v1/runs/:id/preview-share/guests/:guestId']['$post']['input']['json']>>,
    Assert<Mutual<z.infer<typeof guestCommentsSentRequestSchema>, Schema['/api/v1/runs/:id/guest-comments/sent']['$post']['input']['json']>>,
    Assert<Schema['/api/v1/runs/:id/preview-share/guests/:guestId']['$post']['input'] extends { param: unknown } ? true : false>,
    Assert<Schema['/api/v1/runs/:id/preview-share/guests/:guestId']['$delete']['input'] extends { param: unknown } ? true : false>,
    Assert<Schema['/api/v1/runs/:id/guest-comments/:commentId']['$delete']['input'] extends { param: unknown } ? true : false>,
    // The scoped mount is the same sub-app; one path pins that it reached `AppType` too.
    Assert<Schema['/api/v1/p/:projectId/runs/:id/preview-share']['$post']['input'] extends { json: unknown } ? true : false>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
