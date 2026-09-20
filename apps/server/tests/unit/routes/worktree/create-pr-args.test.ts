import { describe, it, expect } from 'vitest';
import { buildPrCreateArgs } from '../../../../src/routes/worktree/routes/create-pr.js';

describe('create-pr buildPrCreateArgs', () => {
  const baseOptions = {
    base: 'main',
    branchName: 'feature/thing',
    title: 'feat: thing',
    body: 'body',
  };

  it('creates drafts by default so PRs cannot be merged by accident', () => {
    const args = buildPrCreateArgs(baseOptions);

    expect(args).toContain('--draft');
    expect(args.slice(0, 3)).toEqual(['pr', 'create', '--base']);
  });

  it('only skips the draft flag when the caller explicitly opts out', () => {
    expect(buildPrCreateArgs({ ...baseOptions, draft: false })).not.toContain('--draft');
    expect(buildPrCreateArgs({ ...baseOptions, draft: true })).toContain('--draft');
  });

  it('uses owner:branch head refs for forks', () => {
    const args = buildPrCreateArgs({
      ...baseOptions,
      upstreamRepo: 'upstream/repo',
      originOwner: 'me',
    });

    expect(args).toEqual(
      expect.arrayContaining(['--repo', 'upstream/repo', '--head', 'me:feature/thing'])
    );
  });

  it('uses a plain head branch outside of forks', () => {
    const args = buildPrCreateArgs(baseOptions);

    expect(args).toEqual(expect.arrayContaining(['--head', 'feature/thing']));
    expect(args).not.toContain('--repo');
  });

  it('passes title and body as separate argv entries', () => {
    const args = buildPrCreateArgs({
      ...baseOptions,
      title: 'feat: `weird` $title',
      body: 'line1\nline2',
    });

    expect(args[args.indexOf('--title') + 1]).toBe('feat: `weird` $title');
    expect(args[args.indexOf('--body') + 1]).toBe('line1\nline2');
  });
});
