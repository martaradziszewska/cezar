import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreeShortstat } from '../git-worktree.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * `RunRecord.diffStat` was measured at turn end only, BEFORE the autosave that follows it — and
 * a commit can move the diff anchor (a staged `git merge origin/main` is the live case), so the
 * header kept a number the Changes tab no longer agreed with. These drive real dry-run runs in
 * real worktrees and pin that a COMMITTING autosave re-measures. Each scenario puts work in the
 * tree that no turn-end measurement can have seen, so only the post-autosave refresh can make
 * `diffStat` reflect it.
 */
describe('diffStat is re-measured after a committing autosave', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedAutoname = process.env.CEZ_AUTONAME;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-diffstat-refresh-'));
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_AUTONAME = '0';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    currentId = undefined;
  });

  afterEach(() => {
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedAutoname === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoname;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 20_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const settled = (id: string) => () => !manager.isActive(id);
  /** What the Changes tab would say right now — the same anchor rule, measured on read. */
  const measure = (r: RunRecord) =>
    worktreeShortstat(r.worktreePath as string, r.baseBranch ?? 'HEAD', { taskBranch: r.branch, runStartedAt: r.startedAt });

  it('the run-finalize autosave re-measures (work landed after the last turn end)', async () => {
    // A check step writes after the agent's turn ended: the turn-end measurement cannot have
    // seen it, and the finalize autosave is what commits it.
    const workflow: WorkflowDef = {
      name: 'agent-then-write',
      source: 'built-in',
      steps: [
        { id: 'work', name: 'Work', prompt: '{{task}}' },
        { id: 'late', name: 'Late write', command: "printf 'x\\ny\\n' > late.txt" },
      ],
    };
    const record = manager.startRun(workflow, { task: 'mock:done do it' });
    currentId = record.id;
    await waitFor(() => !!store.getRun(record.id)?.worktreePath);
    await waitFor(settled(record.id));

    const after = store.getRun(record.id) as RunRecord;
    const { stdout } = await run('git', ['log', '-1', '--format=%s'], { cwd: after.worktreePath as string });
    expect(stdout.trim()).toBe('cezar autosave (run finalize)');
    // The dry-run agent leaves its own one-line file; late.txt's two lines come on top.
    const now = await measure(after);
    expect(now?.adds).toBeGreaterThanOrEqual(2);
    expect(after.diffStat).toEqual(now);
  }, 40_000);

  it('the turn-end autosave of a continuation re-measures', async () => {
    const single: WorkflowDef = {
      name: 'single',
      source: 'built-in',
      steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
    };
    const record = manager.startRun(single, { task: 'mock:done first pass' });
    currentId = record.id;
    await waitFor(() => !!store.getRun(record.id)?.worktreePath);
    await waitFor(settled(record.id));
    const first = store.getRun(record.id) as RunRecord;
    const wt = first.worktreePath as string;
    expect(first.diffStat).toEqual(await measure(first));
    const before = { ...first.diffStat }; // the record is live — snapshot, don't alias

    // Silence the turn-end measurement so the only writer left is the post-autosave one —
    // the stand-in for "the turn-end number was taken before the commit moved the anchor".
    (manager as unknown as { recordTurnEnd: () => Promise<void> }).recordTurnEnd = async () => undefined;
    writeFileSync(join(wt, 'more.txt'), 'a\nb\nc\n');
    expect(manager.continueRun(record.id, { text: 'mock:done second pass' })).toEqual({ ok: true });
    await waitFor(() => (store.getRun(record.id)?.steps.length ?? 0) > 1);
    await waitFor(settled(record.id));

    const { stdout } = await run('git', ['log', '-1', '--format=%s'], { cwd: wt });
    expect(stdout.trim()).toBe('cezar autosave (turn end)');
    const latest = store.getRun(record.id) as RunRecord;
    // The mock's second pass adds a line of its own, so: more.txt on top of the first pass,
    // and exactly what the Changes tab measures now.
    expect(latest.diffStat?.adds).toBeGreaterThanOrEqual((before.adds ?? 0) + 3);
    expect(latest.diffStat).toEqual(await measure(latest));
  }, 40_000);
});
