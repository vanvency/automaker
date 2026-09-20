import { describe, it, expect } from 'vitest';
import { selectOpenCodeSession } from '../../../../src/routes/features/routes/opencode-session.js';

const PROJECT_ROOT = '/workspace/vibe-llmops';

function session(id: string, directory: string, title: string, updated: number) {
  return { id, directory, title, updated, created: updated };
}

describe('selectOpenCodeSession', () => {
  it('prefers a session from the feature worktree with a matching title', () => {
    const sessions = [
      session('ses_old', `${PROJECT_ROOT}/.worktrees/aip-114829-kaka`, 'unrelated work', 10),
      session(
        'ses_match',
        `${PROJECT_ROOT}/.worktrees/aip-114829-kaka`,
        '知识库操作审计日志支持导出',
        20
      ),
    ];

    const picked = selectOpenCodeSession(sessions, {
      workDir: `${PROJECT_ROOT}/.worktrees/aip-114829-kaka`,
      preferredTitle: 'AIP-114829: 【知识库审计】知识库操作审计日志支持导出',
      projectRoot: PROJECT_ROOT,
    });

    expect(picked?.id).toBe('ses_match');
  });

  it('falls back to a sibling worktree of the same project', () => {
    const sessions = [
      session(
        'ses_sibling',
        `${PROJECT_ROOT}/.worktrees/aip-114829-kaka-old`,
        '知识库操作审计日志支持导出',
        30
      ),
    ];

    const picked = selectOpenCodeSession(sessions, {
      workDir: `${PROJECT_ROOT}/.worktrees/aip-114829-kaka`,
      preferredTitle: 'AIP-114829: 【知识库审计】知识库操作审计日志支持导出',
      projectRoot: PROJECT_ROOT,
    });

    expect(picked?.id).toBe('ses_sibling');
  });

  it('never links to a session from another project', () => {
    const sessions = [
      session(
        'ses_other',
        '/workspace/other-repo/.worktrees/thing',
        '知识库操作审计日志支持导出',
        99
      ),
    ];

    const picked = selectOpenCodeSession(sessions, {
      workDir: `${PROJECT_ROOT}/.worktrees/aip-114829-kaka`,
      preferredTitle: 'AIP-114829: 【知识库审计】知识库操作审计日志支持导出',
      projectRoot: PROJECT_ROOT,
    });

    expect(picked).toBeNull();
  });

  it('returns null when the worktree has no session at all', () => {
    const sessions = [
      session('ses_a', `${PROJECT_ROOT}/.worktrees/aip-114819-kaka`, 'unrelated', 5),
      session('ses_b', `${PROJECT_ROOT}/.worktrees/aip-114866-dodo`, 'other', 6),
    ];

    const picked = selectOpenCodeSession(sessions, {
      workDir: `${PROJECT_ROOT}/.worktrees/aip-114829-kaka`,
      preferredTitle: 'AIP-114829: 【知识库审计】知识库操作审计日志支持导出',
      projectRoot: PROJECT_ROOT,
    });

    expect(picked).toBeNull();
  });

  it('still falls back to the newest same-worktree session without a title match', () => {
    const sessions = [
      session('ses_older', `${PROJECT_ROOT}/.worktrees/aip-1-kaka`, 'first', 100),
      session('ses_newer', `${PROJECT_ROOT}/.worktrees/aip-1-kaka`, 'second', 200),
    ];

    const picked = selectOpenCodeSession(sessions, {
      workDir: `${PROJECT_ROOT}/.worktrees/aip-1-kaka`,
      preferredTitle: 'completely different wording',
      projectRoot: PROJECT_ROOT,
    });

    expect(picked?.id).toBe('ses_newer');
  });

  it('handles an empty session list', () => {
    expect(
      selectOpenCodeSession([], {
        workDir: `${PROJECT_ROOT}/.worktrees/aip-1-kaka`,
        projectRoot: PROJECT_ROOT,
      })
    ).toBeNull();
  });
});
