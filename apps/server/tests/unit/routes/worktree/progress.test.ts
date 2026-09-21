import { describe, it, expect } from 'vitest';
import type { Feature } from '@automaker/types';
import {
  buildWorktreeProgress,
  classifyStage,
  collectPRs,
  countChangedFiles,
  countTaskStages,
  deriveAttention,
  normalizeBranchName,
  parseBranchStats,
  pickPrimaryFeature,
  toFeatureSummary,
  toProgressTasks,
} from '../../../../src/routes/worktree/routes/progress.js';

function feature(overrides: Partial<Feature> & { id: string }): Feature {
  return {
    category: 'general',
    description: '',
    ...overrides,
  } as Feature;
}

describe('worktree/progress branch helpers', () => {
  it('normalizes feature branch names', () => {
    expect(normalizeBranchName('refs/heads/jira/aip-1')).toBe('jira/aip-1');
    expect(normalizeBranchName('refs/remotes/origin/dev')).toBe('dev');
    expect(normalizeBranchName('origin/dev')).toBe('dev');
    expect(normalizeBranchName('   ')).toBeNull();
    expect(normalizeBranchName(null)).toBeNull();
  });

  it('classifies feature statuses onto progress stages', () => {
    expect(classifyStage('backlog')).toBe('backlog');
    expect(classifyStage('in_progress')).toBe('in_progress');
    expect(classifyStage('in-progress')).toBe('in_progress');
    expect(classifyStage('waiting_approval')).toBe('waiting_approval');
    expect(classifyStage('Waiting Approval')).toBe('waiting_approval');
    expect(classifyStage('verified')).toBe('complete');
    expect(classifyStage('failed')).toBe('failed');
    // Everything that needs a human belongs to the "Needs Attention" lane, not
    // to Backlog via the `unknown` fallback.
    expect(classifyStage('merge_conflict')).toBe('failed');
    expect(classifyStage('interrupted')).toBe('failed');
    expect(classifyStage('needs_input')).toBe('failed');
    expect(classifyStage('something-new')).toBe('unknown');
    // Missing status means the feature has not been picked up yet.
    expect(classifyStage(undefined)).toBe('backlog');
  });

  it('parses for-each-ref output including ahead/behind counts', () => {
    const sep = '\x1f';
    const stdout = [
      [
        'jira/aip-114819-kaka',
        '3bc2d05',
        '2026-09-12T15:02:06+08:00',
        'haojun.fan',
        '6 187',
        'chore: retry root MR',
      ].join(sep),
      ['dev', 'f3b955b', '2026-09-09T19:17:56+08:00', 'haojun.fan', '0 0', 'release dev'].join(sep),
      '',
    ].join('\n');

    const stats = parseBranchStats(stdout);

    expect(stats.get('jira/aip-114819-kaka')).toEqual({
      sha: '3bc2d05',
      date: '2026-09-12T15:02:06+08:00',
      author: 'haojun.fan',
      subject: 'chore: retry root MR',
      ahead: 6,
      behind: 187,
    });
    expect(stats.get('dev')?.ahead).toBe(0);
    expect(stats.size).toBe(2);
  });

  it('keeps subjects that contain the field separator and skips malformed lines', () => {
    const stdout = ['a', 'b', 'c', 'd', '1 2', 'subject', 'with separator'].join('\x1f');

    const stats = parseBranchStats(`${stdout}\ngarbage-line\n`);

    expect(stats.get('a')?.subject).toBe('subject\x1fwith separator');
    expect(stats.size).toBe(1);
  });

  it('counts changed files from porcelain output', () => {
    expect(countChangedFiles('')).toBe(0);
    expect(countChangedFiles('\n')).toBe(0);
    expect(countChangedFiles(' M a.ts\n?? b.ts\n')).toBe(2);
  });
});

describe('worktree/progress feature selection', () => {
  it('prefers the most advanced stage, then the most recent update', () => {
    const primary = pickPrimaryFeature([
      feature({ id: 'backlog-1', status: 'backlog', updatedAt: '2026-09-01T00:00:00.000Z' }),
      feature({ id: 'done-1', status: 'verified', updatedAt: '2026-09-02T00:00:00.000Z' }),
      feature({ id: 'running-1', status: 'in_progress', updatedAt: '2026-09-03T00:00:00.000Z' }),
    ]);

    expect(primary?.id).toBe('running-1');
  });

  it('breaks ties by updatedAt and then by id', () => {
    const newer = pickPrimaryFeature([
      feature({ id: 'a', status: 'waiting_approval', updatedAt: '2026-09-01T00:00:00.000Z' }),
      feature({ id: 'b', status: 'waiting_approval', updatedAt: '2026-09-05T00:00:00.000Z' }),
    ]);
    expect(newer?.id).toBe('b');

    const stable = pickPrimaryFeature([
      feature({ id: 'b', status: 'backlog' }),
      feature({ id: 'a', status: 'backlog' }),
    ]);
    expect(stable?.id).toBe('a');
  });

  it('returns null when the branch has no features', () => {
    expect(pickPrimaryFeature([])).toBeNull();
  });

  it('summarizes only the fields the view needs', () => {
    expect(
      toFeatureSummary(
        feature({
          id: 'aip-1',
          title: 'Do the thing',
          status: 'in_progress',
          jiraKey: 'AIP-1',
          jiraUrl: 'https://jira/AIP-1',
          updatedAt: '2026-09-10T00:00:00.000Z',
        })
      )
    ).toEqual({
      id: 'aip-1',
      title: 'Do the thing',
      status: 'in_progress',
      category: 'general',
      jiraKey: 'AIP-1',
      jiraUrl: 'https://jira/AIP-1',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
  });
});

describe('buildWorktreeProgress', () => {
  const worktrees = [
    { path: '/repo', branch: 'dev', isMain: true },
    { path: '/repo/.worktrees/aip-1', branch: 'jira/aip-1', isMain: false },
    { path: '/repo/.worktrees/orphan', branch: 'jira/orphan', isMain: false },
    { path: '/repo/.worktrees/detached', branch: null, isMain: false },
  ];

  const stats = new Map([
    [
      'jira/aip-1',
      {
        sha: 'abc1234',
        subject: 'feat: something',
        author: 'dev',
        date: '2026-09-12T10:00:00.000Z',
        ahead: 3,
        behind: 1,
      },
    ],
  ]);

  const changes = new Map([
    [
      '/repo/.worktrees/aip-1',
      {
        hasChanges: true,
        changedFilesCount: 2,
        hasConflicts: true,
        conflictType: 'rebase' as const,
        conflictFiles: ['a.ts'],
      },
    ],
  ]);

  it('joins worktrees with their feature, git state and PR', () => {
    const items = buildWorktreeProgress({
      worktrees,
      features: [
        feature({
          id: 'aip-1',
          title: 'Feature one',
          status: 'waiting_approval',
          branchName: 'jira/aip-1',
          updatedAt: '2026-09-13T00:00:00.000Z',
        }),
      ],
      branchStats: stats,
      changes,
      prs: new Map([
        [
          'jira/aip-1',
          {
            number: 12,
            url: 'https://example/pr/12',
            title: 'PR 12',
            state: 'OPEN' as const,
            createdAt: '2026-09-12T00:00:00.000Z',
          },
        ],
      ]),
    });

    const featureRow = items.find((item) => item.branch === 'jira/aip-1')!;
    expect(featureRow.stage).toBe('waiting_approval');
    expect(featureRow.feature?.id).toBe('aip-1');
    expect(featureRow.featureCount).toBe(1);
    expect(featureRow.head?.sha).toBe('abc1234');
    expect([featureRow.ahead, featureRow.behind]).toEqual([3, 1]);
    expect(featureRow.hasChanges).toBe(true);
    expect(featureRow.changedFilesCount).toBe(2);
    expect(featureRow.hasConflicts).toBe(true);
    expect(featureRow.conflictType).toBe('rebase');
    expect(featureRow.pr?.number).toBe(12);
    // Feature update is newer than the branch tip.
    expect(featureRow.lastActivityAt).toBe('2026-09-13T00:00:00.000Z');
  });

  it('marks worktrees without a feature as empty and handles detached HEAD', () => {
    const items = buildWorktreeProgress({
      worktrees,
      features: [],
      branchStats: stats,
      changes,
      prs: new Map(),
    });

    expect(items.map((item) => item.stage)).toEqual(['empty', 'empty', 'empty', 'empty']);
    expect(items[0].isMain).toBe(true);
    expect(items[3].branch).toBe('(detached)');
    expect(items[3].head).toBeNull();
    expect(items[3].pr).toBeNull();
  });

  it('counts multiple features per branch but reports the most advanced one', () => {
    const items = buildWorktreeProgress({
      worktrees: [worktrees[1]],
      features: [
        feature({ id: 'f1', branchName: 'jira/aip-1', status: 'backlog' }),
        feature({ id: 'f2', branchName: 'jira/aip-1', status: 'in_progress' }),
        // Feature whose branch has no worktree must not leak into a row.
        feature({ id: 'f3', branchName: 'jira/other', status: 'in_progress' }),
        // Feature without a branch (runs in the main worktree) is ignored.
        feature({ id: 'f4', status: 'in_progress' }),
      ],
      branchStats: stats,
      changes: new Map(),
      prs: new Map(),
    });

    expect(items).toHaveLength(1);
    expect(items[0].featureCount).toBe(2);
    expect(items[0].feature?.id).toBe('f2');
    expect(items[0].stage).toBe('in_progress');
  });
});

describe('collectPRs', () => {
  it('keeps only branches that have PR metadata', () => {
    const pr = {
      number: 1,
      url: 'https://example/pr/1',
      title: 'PR',
      state: 'OPEN' as const,
      createdAt: '2026-09-12T00:00:00.000Z',
    };

    const prs = collectPRs(
      new Map([
        ['jira/a', { pr }],
        ['jira/b', {}],
      ])
    );

    expect([...prs.keys()]).toEqual(['jira/a']);
    expect(prs.get('jira/a')).toEqual(pr);
  });
});

describe('worktree task rollup', () => {
  it('counts the cards of a branch by lifecycle stage', () => {
    const counts = countTaskStages([
      feature({ id: 'parent', status: 'waiting_approval' }),
      feature({ id: 'child-1', status: 'verified' }),
      feature({ id: 'child-2', status: 'completed' }),
      feature({ id: 'child-3', status: 'in_progress' }),
      feature({ id: 'child-4', status: 'failed' }),
      feature({ id: 'child-5', status: 'backlog' }),
    ]);

    expect(counts).toEqual({
      total: 6,
      completed: 2,
      running: 1,
      waiting: 1,
      failed: 1,
      backlog: 1,
    });
  });

  it('links children to their parent card and lists parents first', () => {
    const parent = feature({ id: 'jira-dodo-aip-114878', jiraKey: 'AIP-114878' });
    const children = [
      feature({ id: 'aip-114878-child-1', jiraKey: 'AIP-114878' }),
      feature({ id: 'aip-114878-child-2', jiraKey: 'AIP-114878' }),
    ];
    const all = [parent, ...children];

    const tasks = toProgressTasks(children, all);

    // The worktree only carries the children; the parent lives elsewhere.
    expect(tasks.map((task) => task.id)).toEqual(['aip-114878-child-1', 'aip-114878-child-2']);
    expect(tasks.every((task) => task.isParent === false)).toBe(true);

    const withParent = toProgressTasks(all, all);
    expect(withParent[0].id).toBe('jira-dodo-aip-114878');
    expect(withParent[0].isParent).toBe(true);
    expect(withParent[0].childIds).toEqual(['aip-114878-child-1', 'aip-114878-child-2']);
  });

  it('ranks attention conflicts > needs_input > failed > waiting_review', () => {
    const waiting = feature({ id: 'w', status: 'waiting_approval' });
    const failed = feature({ id: 'f', status: 'failed' });
    const needsInput = feature({ id: 'n', status: 'in_progress', error: 'Which API?' });
    const idle = feature({ id: 'i', status: 'in_progress' });

    expect(deriveAttention([idle], true)).toBe('conflicts');
    expect(deriveAttention([needsInput, failed], false)).toBe('needs_input');
    expect(deriveAttention([failed, waiting], false)).toBe('failed');
    expect(deriveAttention([waiting], false)).toBe('waiting_review');
    expect(deriveAttention([idle], false)).toBeNull();
  });

  it('keeps review notices distinct from input requests and ignores terminal notices', () => {
    const delivered = feature({
      status: 'waiting_approval',
      error: 'MR awaits review',
      executionNotice: {
        kind: 'review',
        source: 'delivery',
        message: 'MR awaits review',
        occurredAt: '2026-09-21T00:00:00Z',
      },
    });
    expect(deriveAttention([delivered], false)).toBe('waiting_review');
    expect(deriveAttention([{ ...delivered, status: 'verified' }], false)).toBeNull();
    expect(deriveAttention([{ ...delivered, executionNotice: undefined }], false)).toBe(
      'needs_input'
    );
  });

  it('attaches the rollup to the worktree row', () => {
    const parent = feature({
      id: 'jira-dodo-aip-114878',
      jiraKey: 'AIP-114878',
      branchName: 'task/aip-114878',
      status: 'in_progress',
    });
    const child = feature({
      id: 'aip-114878-child-1',
      jiraKey: 'AIP-114878',
      branchName: 'task/aip-114878',
      status: 'verified',
    });

    const items = buildWorktreeProgress({
      worktrees: [
        { path: '/repo/.worktrees/task-aip-114878', branch: 'task/aip-114878', isMain: false },
      ],
      features: [parent, child],
      branchStats: new Map(),
      changes: new Map(),
      prs: new Map(),
    });

    expect(items[0].counts).toMatchObject({ total: 2, completed: 1, running: 1 });
    expect(items[0].tasks?.[0].id).toBe('jira-dodo-aip-114878');
    expect(items[0].attention).toBeNull();
  });
});
