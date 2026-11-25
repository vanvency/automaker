import { describe, it, expect } from 'vitest';
import type { Feature } from '@automaker/types';
import {
  featurePromptBlock,
  hasProviderSession,
  previousContextBlock,
  DEVELOPMENT_COMPLETION_POLICY,
} from '../../../src/services/continuation-prompt.js';

const feature = {
  id: 'jira-dodo-aip-114859',
  title: 'AIP-114859: 审计日志导出',
  category: 'Jira AIP / dodo',
  description: 'LONG-DESCRIPTION-BODY',
} as Feature;

describe('continuation-prompt', () => {
  it('overrides legacy root-gitlink delivery instructions for vibe-llmops only', () => {
    expect(DEVELOPMENT_COMPLETION_POLICY).toContain(
      'do not stage or commit submodule gitlink changes'
    );
    expect(DEVELOPMENT_COMPLETION_POLICY).toContain(
      'do not create a root MR solely because submodule checkouts changed'
    );
    expect(DEVELOPMENT_COMPLETION_POLICY).toContain(
      'only when the user explicitly requests an integration/release version-lock update'
    );
    expect(DEVELOPMENT_COMPLETION_POLICY).toContain(
      'For other projects, follow their explicit repository policy'
    );
    expect(DEVELOPMENT_COMPLETION_POLICY).not.toContain('including root gitlinks');
  });

  it('detects whether a conversation can be continued', () => {
    expect(hasProviderSession(feature)).toBe(false);
    expect(hasProviderSession({ ...feature, providerSessionId: 'ses_1' } as Feature)).toBe(true);
    expect(hasProviderSession(null)).toBe(false);
    expect(hasProviderSession(undefined)).toBe(false);
  });

  it('includes the description for the first turn', () => {
    const block = featurePromptBlock(feature);
    expect(block).toContain('LONG-DESCRIPTION-BODY');
    expect(block).toContain(feature.id);
  });
  it('injects separated Jira instructions only on the first turn', () => {
    const imported = {
      ...feature,
      jiraExecutionInstructions: 'Create verified Draft MRs. Preserve the worktree.',
    };
    expect(featurePromptBlock(imported)).toContain(imported.jiraExecutionInstructions);
    expect(featurePromptBlock(imported, { continuing: true })).not.toContain(
      imported.jiraExecutionInstructions
    );
  });

  it('keeps only an anchor when continuing an existing conversation', () => {
    const block = featurePromptBlock(feature, { continuing: true });
    expect(block).not.toContain('LONG-DESCRIPTION-BODY');
    expect(block).toContain(feature.id);
    expect(block).toContain(feature.title as string);
  });

  it('omits the previous agent output when the session already has it', () => {
    expect(previousContextBlock('PREVIOUS-OUTPUT')).toBe('PREVIOUS-OUTPUT');
    expect(previousContextBlock('PREVIOUS-OUTPUT', { continuing: true })).toBe('');
  });
});
