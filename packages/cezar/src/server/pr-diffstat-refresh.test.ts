import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * The draft-PR route's pre-PR autosave is a commit like any other, and a commit can move the
 * diff anchor — a merge left staged at the last turn end is the live case. So the route
 * re-measures `diffStat` after `createDraftPr`, or the header keeps counting the merged-in
 * upstream lines as the task's work. CEZ_DRY_RUN=1 keeps `git push` / `gh` out of it.
 */
describe('POST /runs/:id/pr re-measures diffStat after the pre-PR autosave', () => {
  let repoRoot: string;
  let worktree: string;
  let store: RunStore;
  let manager: RunManager;
  let app: Hono;
  const previousDryRun = process.env.CEZ_DRY_RUN;
  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@local', ...args], { cwd, encoding: 'utf8' });

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });
  afterAll(() => {
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
  });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-pr-diffstat-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    g(repoRoot, 'init', '-q', '-b', 'main');
    g(repoRoot, 'commit', '-q', '--allow-empty', '-m', 'init');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
    // A plain repo stands in for the task worktree, the way git-changes.test.ts does it.
    worktree = mkdtempSync(join(tmpdir(), 'cez-pr-diffstat-wt-'));
    g(worktree, 'init', '-q', '-b', 'main');
    writeFileSync(join(worktree, 'a.txt'), 'base\n');
    g(worktree, 'add', '-A');
    g(worktree, 'commit', '-q', '-m', 'base');
    g(worktree, 'checkout', '-q', '-b', 'cez/abc');
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('stores the post-commit number, not the pre-merge turn-end one', async () => {
    writeFileSync(join(worktree, 'mine.txt'), 'mine\n');
    g(worktree, 'add', '-A');
    g(worktree, 'commit', '-q', '-m', 'task work');
    g(worktree, 'checkout', '-q', 'main');
    writeFileSync(join(worktree, 'upstream.txt'), 'u1\nu2\nu3\n');
    g(worktree, 'add', '-A');
    g(worktree, 'commit', '-q', '-m', 'upstream');
    g(worktree, 'checkout', '-q', 'cez/abc');
    g(worktree, 'merge', '-q', '--no-commit', '--no-ff', 'main');

    const run = store.createRun({ title: 'Ship it', task: 'ship it', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, {
      status: 'review',
      worktreePath: worktree,
      branch: 'cez/abc',
      baseBranch: 'main',
      // What a turn end measured before the merge was committed: main's 3 lines included.
      diffStat: { adds: 4, dels: 0, files: 2 },
    });

    const created = await apiRequest(app, `/api/v1/runs/${run.id}/pr`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321' },
    });

    expect(created.status).toBe(201);
    expect(g(worktree, 'log', '-1', '--format=%s').trim()).toBe('cezar autosave (pre-PR)');
    expect(store.getRun(run.id)?.diffStat).toEqual({ adds: 1, dels: 0, files: 1 });
  });
});
