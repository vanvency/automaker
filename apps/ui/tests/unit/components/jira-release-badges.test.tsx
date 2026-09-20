import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  JiraReleaseBadges,
  releaseLabels,
  releasePriority,
} from '../../../src/components/views/board-view/components/jira-release-badges';

describe('JiraReleaseBadges', () => {
  it('marks a concrete release label as 高优 and shows the release', () => {
    render(
      <JiraReleaseBadges
        labels={['kaka', 'release-20260917', 'release-tbd', 'dodo']}
        data-testid="releases"
      />
    );

    expect(screen.getByText('高优')).toBeInTheDocument();
    expect(screen.getByText('release-20260917')).toBeInTheDocument();
    // release-tbd only means "not scheduled yet" and must not render as a release
    expect(screen.queryByText('release-tbd')).not.toBeInTheDocument();
    expect(screen.queryByText('kaka')).not.toBeInTheDocument();
    expect(screen.queryByText('dodo')).not.toBeInTheDocument();
  });

  it('filters labels case-insensitively and ignores missing labels', () => {
    expect(releaseLabels(['Release-20260917', 'other'])).toEqual(['Release-20260917']);
    expect(releaseLabels(undefined)).toEqual([]);
    expect(releaseLabels([])).toEqual([]);
  });

  it('marks release-tbd or a missing release label as 待定', () => {
    const { unmount } = render(<JiraReleaseBadges labels={['kaka', 'release-tbd']} />);
    expect(screen.getByText('待定')).toBeInTheDocument();
    unmount();

    render(<JiraReleaseBadges labels={['dodo']} />);
    expect(screen.getByText('待定')).toBeInTheDocument();
  });

  describe('releasePriority', () => {
    it('classifies concrete releases as high priority', () => {
      expect(releasePriority(['dodo', 'release-20260917'])).toEqual({
        kind: 'high',
        releases: ['release-20260917'],
      });
      expect(releasePriority(['release-v3.2', 'release-20260917']).releases).toHaveLength(2);
    });

    it('classifies release-tbd and unlabeled cards as tbd', () => {
      expect(releasePriority(['kaka', 'release-tbd'])).toEqual({ kind: 'tbd', releases: [] });
      expect(releasePriority(['kaka'])).toEqual({ kind: 'tbd', releases: [] });
      expect(releasePriority(undefined)).toEqual({ kind: 'tbd', releases: [] });
    });
  });
});
