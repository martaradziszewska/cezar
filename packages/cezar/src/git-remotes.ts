/**
 * Which remote is the PR target, and which one the task branch is pushed to.
 *
 * A clone is not always `origin` = the repo PRs go to. The common fork layout
 * is `origin` = your fork and `upstream` = the canonical repo, and there a
 * task forked from `origin/main` starts from a fork that lags the repo the PR
 * is opened against — `gh pr create` already prefers `upstream` — so the PR
 * drags stale history and conflicts. The opposite layout (`origin` = canonical,
 * `fork` = yours) works by accident today. Both must work with zero config, so
 * both questions are answered once, here, from what git already knows:
 *
 * - **base remote** (PR target, the one new tasks fork from and diffs measure
 *   against): the remote `gh repo set-default` marked (`remote.<name>.gh-resolved
 *   = base`), else the first of `upstream`, `github`, `origin` — the order `gh`
 *   itself resolves a base repo in — else the only/first remote.
 * - **push remote** (where `cez/<id8>` goes): `remote.pushDefault` when it names
 *   a remote, else `origin`, else the base remote.
 *
 * Pure decision over a caller-supplied runner (same shape as `git-diff-base.ts`),
 * so every caller keeps its own process-spawning. Never throws; null when the
 * repo has no remotes.
 */

/** What a caller's `git` runner must answer with. */
export interface RemoteGitRunResult {
  ok: boolean;
  stdout: string;
}

export type RemoteGitRunner = (args: string[]) => Promise<RemoteGitRunResult>;

export interface TaskRemotes {
  /** The PR-target remote, or null when the repo has no remotes. */
  base: string | null;
  /** The remote the task branch is pushed to, or null when the repo has no remotes. */
  push: string | null;
  /** Every configured remote name — what `splitRemoteRef` recognizes as a prefix. */
  names: string[];
}

/** gh's own base-repo preference among conventional remote names. */
const BASE_REMOTE_ORDER = ['upstream', 'github', 'origin'];

export async function resolveTaskRemotes(runGit: RemoteGitRunner): Promise<TaskRemotes> {
  const listed = await runGit(['remote']);
  const names = listed.ok ? listed.stdout.split('\n').map((n) => n.trim()).filter(Boolean) : [];
  if (names.length === 0) return { base: null, push: null, names };

  let base: string | null = null;
  const resolved = await runGit(['config', '--get-regexp', '^remote\\..*\\.gh-resolved$']);
  if (resolved.ok) {
    for (const line of resolved.stdout.split('\n')) {
      const m = /^remote\.(.+)\.gh-resolved\s+(\S+)\s*$/.exec(line.trim());
      if (m && m[2] === 'base' && names.includes(m[1] as string)) {
        base = m[1] as string;
        break;
      }
    }
  }
  base ??= BASE_REMOTE_ORDER.find((n) => names.includes(n)) ?? (names[0] as string);

  const pushDefault = await runGit(['config', '--get', 'remote.pushDefault']);
  const configuredPush = pushDefault.ok ? pushDefault.stdout.trim() : '';
  const push = names.includes(configuredPush) ? configuredPush : names.includes('origin') ? 'origin' : base;
  return { base, push, names };
}

/**
 * Split `upstream/main` into `{ remote: 'upstream', branch: 'main' }` when the
 * prefix is a configured remote; a plain branch name (or a branch whose name
 * merely contains a slash, `feat/x`) comes back with `remote: null`. The
 * longest matching remote name wins, so a remote called `a/b` is not mistaken
 * for `a`.
 */
export function splitRemoteRef(ref: string, names: readonly string[]): { remote: string | null; branch: string } {
  let best: string | null = null;
  for (const name of names) {
    if (ref.startsWith(`${name}/`) && ref.length > name.length + 1 && (!best || name.length > best.length)) {
      best = name;
    }
  }
  return best ? { remote: best, branch: ref.slice(best.length + 1) } : { remote: null, branch: ref };
}
