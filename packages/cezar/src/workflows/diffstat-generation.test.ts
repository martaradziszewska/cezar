import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every measurement is a promise the test resolves by hand, in the order it chooses. */
const pending: Array<(stat: { files: number; adds: number; dels: number }) => void> = [];
vi.mock('../git-worktree.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git-worktree.ts')>()),
  worktreeShortstat: () => new Promise((resolve) => pending.push(resolve)),
}));

const { RunStore } = await import('../runs/store.ts');
const { RunManager } = await import('./run.ts');

/**
 * `refreshDiffStat` lets only the most recently STARTED measurement write. The generation it
 * compares against must therefore keep counting up for the life of the run: if it reset once a
 * measurement landed, a measurement started AFTER that reset would reuse an old one's number,
 * and the old, slow one — taken before a commit moved the anchor — would pass the check and
 * write a stale count over the newer one.
 */
describe('refreshDiffStat — only the newest measurement writes', () => {
  let dir: string;
  let store: ReturnType<typeof RunStore.open>;
  let manager: InstanceType<typeof RunManager>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-diffstat-gen-'));
    store = RunStore.open(join(dir, '.ai/cezar'));
    manager = new RunManager(store, dir);
    pending.length = 0;
  });
  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('a slow, older measurement never overwrites one started after a newer one landed', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    store.updateRun(run.id, { worktreePath: dir }); // any existing directory will do

    const stale = manager.refreshDiffStat(run.id); // A: started first, before the commit
    const newer = manager.refreshDiffStat(run.id); // B
    await flush();
    pending[1]!({ files: 2, adds: 20, dels: 0 }); // B lands
    await newer;
    const newest = manager.refreshDiffStat(run.id); // C: started after B landed
    await flush();
    pending[0]!({ files: 9, adds: 999, dels: 9 }); // A finally lands — stale
    await stale;
    pending[2]!({ files: 3, adds: 30, dels: 1 }); // C lands
    await newest;

    expect(store.getRun(run.id)?.diffStat).toEqual({ files: 3, adds: 30, dels: 1 });
  });
});
