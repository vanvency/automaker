#!/usr/bin/env python3
"""Tests for the branch matching used by audit-mr-drafts.py."""
import importlib.util
import unittest
from pathlib import Path


def load_audit():
    spec = importlib.util.spec_from_file_location(
        'audit_mr_drafts', Path(__file__).with_name('audit-mr-drafts.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit = load_audit()


class AutomakerBranchTests(unittest.TestCase):
    def test_matches_current_type_prefixed_branches(self):
        for branch in ('task/aip-114859', 'feat/aip-114859-kaka', 'story/aip-1-dodo',
                       'epic/aip-7', 'impr/aip-2', 'bugfix/aip-3', 'jira/aip-123'):
            self.assertTrue(audit.is_automaker_branch(branch), branch)

    def test_matches_legacy_jira_branches(self):
        for branch in ('jira/aip-114859-kaka', 'jira/aip-4-dodo'):
            self.assertTrue(audit.is_automaker_branch(branch), branch)

    def test_rejects_unrelated_branches(self):
        for branch in ('main', 'dev', 'feature/foo', 'task/not-a-jira-key',
                       'task/aip-123/extra'):
            self.assertFalse(audit.is_automaker_branch(branch), branch)

    def test_board_membership_wins_for_unknown_names(self):
        # A feature that was dispatched under a custom prefix still has its MR
        # forced to draft, because the board knows the branch.
        self.assertTrue(audit.is_automaker_branch('userstory/aip-9', {'userstory/aip-9'}))
        self.assertFalse(audit.is_automaker_branch('userstory/aip-9', set()))

    def test_project_key_narrows_the_pattern(self):
        pattern = audit.automaker_branch_pattern('AIP')
        self.assertTrue(pattern.match('task/aip-5'))
        self.assertFalse(pattern.match('task/other-5'))


if __name__ == '__main__':
    unittest.main()
