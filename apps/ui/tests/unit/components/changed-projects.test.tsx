import { describe, it, expect } from 'vitest';
import {
  deriveProjectNameFromMrUrl,
  getChangedProjects,
} from '@/components/views/board-view/components/kanban-card/changed-projects';
import type { Feature } from '@/store/app-store';

function feature(overrides: Partial<Feature>): Feature {
  return { id: 'feature-1', description: '', status: 'waiting_approval', ...overrides } as Feature;
}

describe('changed projects', () => {
  it('derives the repository path from the MR url when the label is generic', () => {
    const summary = [
      '### Notes for Developer',
      '- MRs (opened, target `dev`, not auto-merged):',
      '  - 子项目: http://gitblue.transwarp.io/saas/saas-frontend/-/merge_requests/2038',
      '  - 根仓: http://gitblue.transwarp.io/llm/llmops/product/vibe-llmops/-/merge_requests/9',
    ].join('\n');

    const projects = getChangedProjects(feature({ summary }));

    // The card shows the repository name, not the generic 子项目/根仓 label
    expect(projects.map((project) => project.name)).toEqual(['saas-frontend', 'vibe-llmops']);
  });

  it('keeps explicit project names untouched', () => {
    const summary = [
      '- MRs:',
      '  - frontend/saas-frontend: http://gitblue.transwarp.io/saas/saas-frontend/-/merge_requests/2038',
    ].join('\n');

    const projects = getChangedProjects(feature({ summary }));

    expect(projects.map((project) => project.name)).toEqual(['saas-frontend']);
  });

  it('normalizes generic labels coming from changedProjects as well', () => {
    const projects = getChangedProjects(
      feature({
        changedProjects: [
          {
            name: '子项目',
            mrUrl: 'http://gitblue.transwarp.io/llm/llmops/kb-agent/-/merge_requests/124',
          },
        ],
      } as Partial<Feature>)
    );

    expect(projects.map((project) => project.name)).toEqual(['kb-agent']);
  });

  it('resolves project paths from both GitLab URL shapes', () => {
    expect(
      deriveProjectNameFromMrUrl(
        'http://gitblue.transwarp.io/saas/saas-frontend/-/merge_requests/2038'
      )
    ).toBe('saas/saas-frontend');
    expect(
      deriveProjectNameFromMrUrl('http://gitblue.transwarp.io/saas/saas-frontend/merge_requests/2')
    ).toBe('saas/saas-frontend');
  });
  it('deduplicates AIP-115448 receipt and summary aliases by MR identity', () => {
    const cas = 'http://gitblue.transwarp.io/aip/infra/central-auth-service/-/merge_requests/1713';
    const root = 'http://gitblue.transwarp.io/llm/llmops/product/vibe-llmops/-/merge_requests/45';
    expect(
      getChangedProjects(
        feature({
          changedProjects: [
            { name: 'backend/central-auth-service', mrUrl: cas },
            { name: 'root (vibe-llmops)', mrUrl: root },
          ],
          mergeRequests: [cas, root],
          summary: `- 子模块 MR：${cas}\n- 根仓库 MR：${root}`,
        })
      )
    ).toEqual([
      { name: 'central-auth-service', mrUrl: cas },
      { name: 'vibe-llmops', mrUrl: root },
    ]);
  });

  it('preserves distinct MRs in the same repository and similarly named repositories on other hosts', () => {
    const urls = [
      'https://git.test/group/service/-/merge_requests/1',
      'https://git.test/group/service/-/merge_requests/2',
      'https://other.test/group/service/-/merge_requests/1',
    ];
    expect(
      getChangedProjects(
        feature({ changedProjects: urls.map((mrUrl) => ({ name: 'service', mrUrl })) })
      )
    ).toEqual(urls.map((mrUrl) => ({ name: 'service', mrUrl })));
  });

  it('treats trailing slashes and legacy GitLab URL shapes as the same MR', () => {
    const mrUrl = 'https://git.test/group/service/-/merge_requests/1';
    expect(
      getChangedProjects(
        feature({
          changedProjects: [{ name: 'backend/service', mrUrl }],
          summary: '- 仓库 MR: https://git.test/group/service/merge_requests/1/',
        })
      )
    ).toEqual([{ name: 'service', mrUrl }]);
  });
});
