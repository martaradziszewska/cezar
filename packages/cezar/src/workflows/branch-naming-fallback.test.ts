import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';

/**
 * The two fallbacks of the branch-name wait (spec 2026-10-11-branch-naming-instructions): a
 * namer slower than the budget, and a namer that answers without a branch. Both fork on
 * `cez/<id8>` and say which one happened. The namer is mocked here because the dry-run mock
 * always answers instantly and always with a branch.
 */

let namerBehaviour: 'stall' | 'no-branch' = 'stall';

vi.mock('../runs/auto-name.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runs/auto-name.ts')>();
  return {
    ...actual,
    generateRunName: vi.fn(async () => {
      if (namerBehaviour === 'stall') return new Promise<never>(() => {});
      return { titleSummary: 'implementing cr fixes' };
    }),
  };
});

import { RunManager } from './run.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const CHECK_ONLY: WorkflowDef = {
  name: 'check-only',
  source: 'built-in',
  steps: [{ id: 'check', command: 'node -e "process.exit(0)"' }],
};

const roots: string[] = [];
const savedAutoname = process.env.CEZ_AUTONAME;

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-branch-fallback-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ branchNaming: 'start with feature/' }));
  return root;
}

async function waitForDone(store: RunStore, id: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (['done', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? '')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${id} did not finish: ${store.getRun(id)?.status}`);
}

beforeEach(() => {
  process.env.CEZ_AUTONAME = '1';
});

afterEach(() => {
  if (savedAutoname === undefined) delete process.env.CEZ_AUTONAME;
  else process.env.CEZ_AUTONAME = savedAutoname;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function runOnce(): Promise<{ branch: string | undefined; notes: string[]; id: string }> {
  const root = fixtureRepo();
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root, { branchNameWaitMs: 50 });
  try {
    const record = manager.startRun(CHECK_ONLY, { task: 'implement the cr fixes' });
    await waitForDone(store, record.id);
    const notes = store.readEvents(record.id).filter((e) => e.type === 'note').map((e) => String(e.message));
    return { branch: store.getRun(record.id)?.branch, notes, id: record.id };
  } finally {
    manager.dispose();
    store.flush();
  }
}

describe('branch naming fallbacks', () => {
  it('a namer slower than the wait budget forks on cez/<id8> and says so', async () => {
    namerBehaviour = 'stall';
    const { branch, notes, id } = await runOnce();
    expect(branch).toBe(`cez/${id.slice(0, 8)}`);
    expect(notes.some((n) => n.includes('not ready in time'))).toBe(true);
  }, 30_000);

  it('a namer that answers without a branch forks on cez/<id8> with the other note', async () => {
    namerBehaviour = 'no-branch';
    const { branch, notes, id } = await runOnce();
    expect(branch).toBe(`cez/${id.slice(0, 8)}`);
    expect(notes.some((n) => n.includes('answered no branch name'))).toBe(true);
    expect(notes.some((n) => n.includes('not ready in time'))).toBe(false);
  }, 30_000);
});
