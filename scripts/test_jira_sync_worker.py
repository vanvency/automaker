import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import os
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('managed_worker', Path(__file__).with_name('jira-sync-worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ManagedSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = {
            'jiraUrl': 'https://jira.example', 'projectPath': str(self.root),
            'targetBranch': 'dev', 'autoStart': True, 'maxDispatchPerRun': 1,
        }
        self.card = {
            'id': 'jira-dodo-aip-1', 'jiraKey': 'AIP-1', 'jiraUrl': 'https://jira.example/browse/AIP-1',
            'title': 'New requirement', 'description': 'new requirements', 'jiraLabels': ['dodo'],
            'branchName': 'task/aip-1', 'worktree': str(self.root / 'wt'),
            'jiraContext': {'version': 'new', 'path': '.automaker/jira/aip-1/context.md'},
            'contextMarkdown': 'new context', 'dependencies': [],
        }
        self.issue = {'id': '10001', 'key': 'AIP-1', 'fields': {'status': {'name': 'To Do'}}}
        self.api = Mock()
        self.features = []
        self.api.call.side_effect = lambda route, body: (
            {'features': self.features} if route == 'features/list' else {'runningFeatures': []})

    def plan(self, state=None):
        with patch.object(worker.monitor, 'search', return_value=[self.issue]), \
             patch.object(worker.monitor, 'issue_mode', return_value=('auto', 'dodo')), \
             patch.object(worker, 'delivery_plan', return_value={'cards': [copy.deepcopy(self.card)]}), \
             patch.object(worker.monitor, 'issue_detail', return_value=self.issue), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            return worker.build_plan(self.config, self.api, state or {}, 'run-1')

    def test_reset_preview_and_execute_create_fresh_card_without_old_session(self):
        old_tree = self.root / 'old-tree'
        old_tree.mkdir()
        old = {
            'id': 'old-card', 'jiraKey': 'AIP-1', 'jiraIssueId': '10001',
            'jiraInstanceUrl': 'https://jira.example', 'branchName': 'task/aip-1',
            'jiraDelivery': {'worktree': str(old_tree)}, 'status': 'waiting_approval',
            'providerSessionId': 'old-private-session',
        }
        self.features = [old]
        card = {**self.card, 'jiraDelivery': {'branch': 'task/aip-1', 'worktree': str(old_tree)}}
        state = {'jobs': {'AIP-1': {'featureId': 'old-card', 'dispatchClaim': 'old-run'}}}
        new_tree = self.root / 'new-tree'
        with patch.object(worker.monitor, 'issue_detail', return_value=self.issue), \
             patch.object(worker.monitor, 'issue_mode', return_value=('auto', 'dodo')), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, d: str(old_tree) if b == 'task/aip-1' else str(new_tree)), \
             patch.object(worker, 'delivery_plan', return_value={'cards': [card]}), \
             patch.object(worker.monitor, 'checked', side_effect=lambda args, *a: (
                 'worktree ' + str(old_tree) + '\n' if args[1:3] == ['worktree', 'list']
                 else 'task/aip-1\n' if args[1:3] == ['branch', '--show-current'] else '')), \
             patch.object(worker.monitor, 'command', return_value=Mock(returncode=1)), \
             patch.object(worker.monitor, 'ensure_worktree_for_branch', side_effect=lambda *a: new_tree.mkdir()), \
             patch.object(worker.monitor, 'save') as save:
            preview = worker.reset_work(self.config, self.api, state, self.root / 'state.json',
                                        {'featureId': old['id'], 'mode': 'reset-preview'})
            self.assertFalse(self.api.call.called and any(
                call.args[0] == 'features/create' for call in self.api.call.call_args_list))
            self.assertEqual(preview['reset']['oldBranch'], 'task/aip-1')
            with self.assertRaisesRegex(worker.ResetBlocked, 'preview reset again'):
                worker.reset_work(self.config, self.api, state, self.root / 'state.json',
                                  {'featureId': old['id'], 'mode': 'reset',
                                   'snapshot': '0' * 64})
            result = worker.reset_work(self.config, self.api, state, self.root / 'state.json',
                                       {'featureId': old['id'], 'mode': 'reset',
                                        'snapshot': preview['reset']['snapshot'], 'runId': 'new-run'})
            created = next(call.args[1]['feature'] for call in self.api.call.call_args_list
                           if call.args[0] == 'features/create')
            self.assertEqual(created['id'], result['reset']['featureId'])
            self.assertNotIn('providerSessionId', created)
            self.assertTrue(created['branchName'].startswith('task/aip-1-reset-'))
            self.assertEqual(state['jobs']['AIP-1']['featureId'], created['id'])
            self.assertNotIn('dispatchClaim', state['jobs']['AIP-1'])
            self.assertTrue(save.called)

    def test_sync_selects_reset_card_even_when_old_jira_card_is_archived(self):
        self.features = [
            {'id': 'old-card', 'jiraKey': 'AIP-1', 'jiraIssueId': '10001',
             'jiraInstanceUrl': self.config['jiraUrl'], 'archive': {'reason': 'deferred'}},
            {'id': 'jira-reset-new', 'jiraKey': 'AIP-1', 'jiraIssueId': '10001',
             'jiraInstanceUrl': self.config['jiraUrl'], 'branchName': 'task/aip-1-reset-new',
             'status': 'backlog'},
        ]
        plans, changes = self.plan()
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]['card']['id'], 'jira-reset-new')
        self.assertFalse(any(change['action'] == 'blocked' for change in changes))

    def test_reset_failure_archives_abandoned_attempt_and_rotates_preview(self):
        old_tree = self.root / 'old-tree'
        old_tree.mkdir()
        new_tree = self.root / 'new-tree'
        old = {'id': 'old', 'jiraKey': 'AIP-1', 'branchName': 'task/aip-1'}
        card = {**self.card, 'id': 'jira-reset-attempt', 'jiraIssueId': '10001',
                'worktree': str(new_tree),
                'branchName': 'task/aip-1-reset-attempt',
                'jiraDelivery': {'branch': 'task/aip-1-reset-attempt',
                                 'worktree': str(new_tree)}}
        state = {'jobs': {'AIP-1': {'featureId': 'old'}}}
        calls = []
        def call(route, body):
            calls.append((route, body))
            if route == 'features/archive' and body['featureId'] == 'old':
                raise RuntimeError('conversation still busy')
            if route == 'features/get':
                return {'feature': old}
            return {}
        self.api.call.side_effect = call
        with patch.object(worker, 'reset_plan', return_value=(old, old_tree, card, 'a' * 64)), \
             patch.object(worker.monitor, 'checked', side_effect=lambda args, *a: (
                 'worktree ' + str(old_tree) + '\n' if args[1:3] == ['worktree', 'list']
                 else 'task/aip-1\n' if args[1:3] == ['branch', '--show-current'] else '')), \
             patch.object(worker.monitor, 'command', return_value=Mock(returncode=1)), \
             patch.object(worker.monitor, 'ensure_worktree_for_branch', side_effect=lambda *a: new_tree.mkdir()), \
             patch.object(worker.monitor, 'save'):
            with self.assertRaisesRegex(RuntimeError, 'conversation still busy'):
                worker.reset_work(self.config, self.api, state, self.root / 'state.json',
                                  {'featureId': 'old', 'mode': 'reset',
                                   'snapshot': 'a' * 64, 'runId': 'new-run'})
        self.assertEqual(state['resetAttempts']['old'], 1)
        self.assertEqual(state['jobs']['AIP-1']['featureId'], 'old')
        self.assertIn(('features/archive', {'projectPath': str(self.root),
                                            'featureId': card['id'],
                                            'archive': {'reason': 'deferred',
                                                        'description': 'Reset failed before replacing the old work; abandoned attempt.'}}), calls)

    def test_reset_does_not_rollback_when_archive_response_was_lost(self):
        old_tree = self.root / 'old-tree'
        old_tree.mkdir()
        new_tree = self.root / 'new-tree'
        old = {'id': 'old', 'jiraKey': 'AIP-1', 'branchName': 'task/aip-1'}
        card = {**self.card, 'id': 'jira-reset-attempt', 'jiraIssueId': '10001',
                'worktree': str(new_tree),
                'branchName': 'task/aip-1-reset-attempt',
                'jiraDelivery': {'branch': 'task/aip-1-reset-attempt',
                                 'worktree': str(new_tree)}}
        state = {'jobs': {'AIP-1': {'featureId': 'old'}}}
        calls = []
        def call(route, body):
            calls.append((route, body))
            if route == 'features/archive' and body['featureId'] == 'old':
                raise RuntimeError('response lost')
            if route == 'features/get':
                return {'feature': dict(old, archive={'reason': 'deferred'})}
            return {}
        self.api.call.side_effect = call
        with patch.object(worker, 'reset_plan', return_value=(old, old_tree, card, 'a' * 64)), \
             patch.object(worker.monitor, 'checked', side_effect=lambda args, *a: (
                 'worktree ' + str(old_tree) + '\n' if args[1:3] == ['worktree', 'list']
                 else 'task/aip-1\n' if args[1:3] == ['branch', '--show-current'] else '')), \
             patch.object(worker.monitor, 'command', return_value=Mock(returncode=1)), \
             patch.object(worker.monitor, 'ensure_worktree_for_branch', side_effect=lambda *a: new_tree.mkdir()), \
             patch.object(worker.monitor, 'save'):
            result = worker.reset_work(self.config, self.api, state, self.root / 'state.json',
                                       {'featureId': 'old', 'mode': 'reset',
                                        'snapshot': 'a' * 64, 'runId': 'new-run'})
        self.assertEqual(state['jobs']['AIP-1']['featureId'], result['reset']['featureId'])
        self.assertFalse(any(route == 'features/archive' and body['featureId'] == card['id']
                             for route, body in calls))

    def test_preview_is_read_only_and_identifies_proposed_dispatch(self):
        entries, changes = self.plan()
        self.assertEqual([c['action'] for c in changes], ['create', 'dispatch'])
        self.assertTrue(entries[0]['card']['id'].startswith('jira-'))
        self.assertTrue(all(call.args[0] in ('features/list', 'auto-mode/status') for call in self.api.call.call_args_list))
        self.assertFalse((self.root / 'wt').exists())

    def test_requirements_are_separate_from_execution_rules_and_active_prompts_are_preserved(self):
        self.config.update(jiraProject='AIP', model='pi:litellm/worker', reasoningEffort='medium')
        issue = {'key': 'AIP-1', 'fields': {
            'summary': 'Hide MCP headers', 'description': 'MCP must hide headers; REST must retain them.',
            'issuetype': {'name': 'Bug'}, 'attachment': [{'filename': 'reference.png'}],
        }}
        with patch.object(worker.monitor, 'issue_detail', return_value=issue), \
             patch.object(worker.monitor, 'jira_lineage', return_value={'task': issue}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            card = worker.delivery_plan(self.config, 'AIP-1', [], 'dodo')['cards'][0]
        self.assertEqual(card['description'], issue['fields']['description'])
        self.assertEqual(card['jiraSummary'], 'Hide MCP headers')
        self.assertNotIn('D1.', card['description'])
        self.assertIn('Draft MR', card['jiraExecutionInstructions'])
        self.assertIn('reference.png', card['jiraExecutionInstructions'])
        self.assertNotIn(issue['fields']['description'], card['jiraExecutionInstructions'])
        updates = worker.changes_for({'status': 'backlog'}, card, 'run')
        self.assertEqual(updates['jiraExecutionInstructions'], card['jiraExecutionInstructions'])
        active = worker.changes_for({'status': 'in_progress', 'providerSessionId': 'keep'}, card, 'run')
        self.assertNotIn('description', active)
        self.assertNotIn('jiraExecutionInstructions', active)
        self.assertEqual(active['jiraPendingDescription'], card['description'])

    def test_people_are_imported_and_refreshed_without_changing_execution(self):
        fields = {'assignee': {'name': 'alice', 'displayName': 'Alice'},
                  'reporter': {'accountId': 'bob-id', 'displayName': 'Bob'}}
        people = worker.monitor.issue_people(fields)
        self.assertEqual(people, {
            'jiraAssignee': 'alice', 'jiraAssigneeDisplayName': 'Alice',
            'jiraReporter': 'bob-id', 'jiraReporterDisplayName': 'Bob',
        })
        updates = worker.changes_for(
            {'status': 'in_progress', 'jiraAssignee': 'old'}, people, 'run')
        self.assertEqual(updates['jiraReporter'], 'bob-id')
        self.assertEqual(updates['jiraAssigneeDisplayName'], 'Alice')
        self.assertNotIn('status', updates)
        cleared = worker.changes_for(people, worker.monitor.issue_people({}), 'next')
        self.assertIsNone(cleared['jiraAssignee'])
        self.assertIsNone(cleared['jiraReporter'])

    def test_normal_sync_keeps_epic_as_one_delivery_without_expanding_stories(self):
        self.config.update(jiraProject='AIP', model='pi:litellm/worker', reasoningEffort='medium',
                           executionUnit='task', worktreeScope='story', subtaskCards=True)
        epic = {'id': '10001', 'key': 'AIP-1', 'fields': {
            'summary': 'Parent scope', 'issuetype': {'name': 'Epic'}, 'labels': ['dodo'],
            'subtasks': [{'key': 'AIP-2', 'fields': {'summary': 'Frontend', 'issuetype': {'name': 'Sub-task'}}}],
        }}
        with patch.object(worker.monitor, 'search', return_value=[epic]), \
             patch.object(worker.monitor, 'issue_mode', return_value=('auto', 'dodo')), \
             patch.object(worker.monitor, 'issue_detail', return_value=epic), \
             patch.object(worker.monitor, 'jira_lineage', return_value={'epic': epic}), \
             patch.object(worker.monitor, 'search_jql', return_value=[]), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            entries, changes = worker.build_plan(self.config, self.api, {}, 'run')
        self.assertEqual([e['card']['jiraKey'] for e in entries], ['AIP-1'])
        card = entries[0]['card']
        self.assertEqual([s['key'] for s in card['jiraSubtasks']], ['AIP-2'])
        self.assertIn('do not create Automaker child features'.lower(), ' '.join(card['jiraExecutionInstructions'].lower().split()))
        self.assertEqual(changes[0]['delivery']['issueKey'], 'AIP-1')

    def test_labelled_epic_scans_unlabelled_stories_as_separate_cards_without_dispatch(self):
        self.config.update(jiraProject='AIP', jiraCommand='jira', jql='labels in (dodo)',
                           jiraLabels={'autoStart': ['dodo'], 'manualStart': ['kaka']},
                           model='pi:litellm/worker', reasoningEffort='medium')
        epic = {'id': '10001', 'key': 'AIP-1', 'fields': {
            'summary': 'Epic', 'issuetype': {'name': 'Epic'}, 'labels': ['dodo'],
            'status': {'name': 'To Do'}, 'subtasks': []}}
        story = {'id': '10002', 'key': 'AIP-2', 'fields': {
            'summary': 'Story', 'issuetype': {'name': 'Story'}, 'labels': ['release-tbd'],
            'status': {'name': 'To Do'}, 'subtasks': [
                {'key': 'AIP-3', 'fields': {'summary': 'Task', 'issuetype': {'name': 'Sub-task'}}}],
            worker.monitor.DEFAULT_EPIC_LINK_FIELD: 'AIP-1'}}
        details = {'AIP-1': epic, 'AIP-2': story}
        with patch.object(worker.monitor, 'search', return_value=[epic]), \
             patch.object(worker.monitor, 'search_jql',
                          side_effect=lambda config, jql, limit=200: [story] if 'Epic Link' in jql else []), \
             patch.object(worker.monitor, 'issue_detail', side_effect=lambda config, key: details[key]), \
             patch.object(worker.monitor, 'jira_lineage',
                          side_effect=lambda config, key: {'epic': epic, 'story': story} if key == 'AIP-2'
                          else {'epic': epic}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            entries, changes = worker.build_plan(self.config, self.api, {}, 'run')
        self.assertEqual([entry['card']['jiraKey'] for entry in entries], ['AIP-1', 'AIP-2'])
        self.assertEqual(entries[1]['card']['jiraLabels'], ['release-tbd'])
        self.assertEqual(entries[1]['card']['epicJiraKey'], 'AIP-1')
        self.assertEqual(entries[1]['card']['jiraDelivery']['subtaskKeys'], ['AIP-3'])
        self.assertNotIn('dispatch', entries[1])
        self.assertFalse(any(change['action'] == 'dispatch' and change['issueKey'] == 'AIP-2'
                             for change in changes))

        story['fields']['subtasks'] = []
        existing_card = {**entries[1]['card'], 'status': 'backlog',
                         'jiraDelivery': {**entries[1]['card']['jiraDelivery'],
                                          'storyExecutionApproved': True}}
        self.features = [existing_card]
        with patch.object(worker.monitor, 'search', return_value=[epic]), \
             patch.object(worker.monitor, 'search_jql',
                          side_effect=lambda config, jql, limit=201: [story] if 'Epic Link' in jql else []), \
             patch.object(worker.monitor, 'issue_detail', side_effect=lambda config, key: details[key]), \
             patch.object(worker.monitor, 'jira_lineage',
                          side_effect=lambda config, key: {'epic': epic, 'story': story} if key == 'AIP-2'
                          else {'epic': epic}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            approved, changes = worker.build_plan(self.config, self.api, {}, 'next-run')
        self.assertTrue(approved[1]['card']['jiraDelivery']['storyExecutionApproved'])
        self.assertFalse(approved[1]['card']['jiraDelivery']['requiresDecision'])
        self.assertTrue(approved[1].get('dispatch'))

    def test_epic_story_scan_rejects_unrelated_and_done_stories_and_deduplicates_parent_links(self):
        self.config.update(jiraProject='AIP', jiraCommand='jira', jql='labels in (dodo)',
                           jiraLabels={'autoStart': ['dodo'], 'manualStart': ['kaka']},
                           model='pi:litellm/worker', reasoningEffort='medium')
        epic = {'id': '1', 'key': 'AIP-1', 'fields': {
            'issuetype': {'name': 'Epic'}, 'labels': ['dodo']}}
        story = {'id': '2', 'key': 'AIP-2', 'fields': {
            'issuetype': {'name': 'Story'}, 'labels': ['release-tbd'],
            'parent': {'key': 'AIP-1'}}}
        unrelated = {'id': '3', 'key': 'AIP-3', 'fields': {
            'issuetype': {'name': 'Story'}, 'parent': {'key': 'AIP-99'}}}
        done = {'id': '4', 'key': 'AIP-4', 'fields': {
            'issuetype': {'name': 'Story'}, 'parent': {'key': 'AIP-1'},
            'status': {'statusCategory': {'key': 'done'}}}}
        details = {issue['key']: issue for issue in (epic, story, unrelated, done)}
        with patch.object(worker.monitor, 'search', return_value=[epic]), \
             patch.object(worker.monitor, 'search_jql', return_value=[story, unrelated, done]), \
             patch.object(worker.monitor, 'issue_detail', side_effect=lambda config, key: details[key]), \
             patch.object(worker.monitor, 'jira_lineage',
                          side_effect=lambda config, key: {'story': story, 'epic': epic} if key == 'AIP-2'
                          else {'epic': epic}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            entries, changes = worker.build_plan(self.config, self.api, {}, 'run')
        self.assertEqual([entry['card']['jiraKey'] for entry in entries], ['AIP-1', 'AIP-2'])
        self.assertEqual(len([change for change in changes if change.get('issueKey') == 'AIP-2']), 1)
        self.assertEqual(entries[1]['card']['jiraLabels'], ['release-tbd'])
        self.assertTrue(entries[1]['card']['jiraDelivery']['requiresDecision'])

    def test_imports_story_blockers_as_card_dependencies_and_keeps_external_blockers(self):
        self.config.update(jiraProject='AIP', jiraCommand='jira', jql='labels in (dodo)',
                           jiraLabels={'autoStart': ['dodo'], 'manualStart': ['kaka']},
                           model='pi:litellm/worker', reasoningEffort='medium')
        epic = {'id': '1', 'key': 'AIP-1', 'fields': {
            'issuetype': {'name': 'Epic'}, 'labels': ['dodo']}}
        stories = [
            {'id': '2', 'key': 'AIP-2', 'fields': {
                'issuetype': {'name': 'Story'}, 'labels': [],
                worker.monitor.DEFAULT_EPIC_LINK_FIELD: 'AIP-1',
                'issuelinks': [{'type': {'name': 'Blocks'}, 'inwardIssue': {'key': 'AIP-9'}}]}},
            {'id': '3', 'key': 'AIP-3', 'fields': {
                'issuetype': {'name': 'Story'}, 'labels': [],
                worker.monitor.DEFAULT_EPIC_LINK_FIELD: 'AIP-1',
                'issuelinks': [{'type': {'name': 'Blocks'}, 'inwardIssue': {'key': 'AIP-2'}}]}}
        ]
        details = {issue['key']: issue for issue in [epic, *stories]}
        with patch.object(worker.monitor, 'search', return_value=[epic]), \
             patch.object(worker.monitor, 'search_jql', side_effect=lambda c, q, limit=201:
                          stories if 'Epic Link' in q else []), \
             patch.object(worker.monitor, 'issue_detail', side_effect=lambda c, k: details[k]), \
             patch.object(worker.monitor, 'jira_lineage', side_effect=lambda c, k:
                          {'epic': epic, 'story': details[k]} if k != 'AIP-1' else {'epic': epic}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            entries, changes = worker.build_plan(self.config, self.api, {}, 'run')
        cards = {entry['card']['jiraKey']: entry['card'] for entry in entries}
        self.assertEqual(cards['AIP-2']['dependencies'], ['AIP-9'])
        self.assertEqual(cards['AIP-3']['dependencies'], [cards['AIP-2']['id']])
        self.assertEqual(cards['AIP-3']['jiraDelivery']['blockedBy'], ['AIP-2'])
        self.assertFalse(any(c['action'] == 'dispatch' for c in changes))

        self.features = [{
            **cards['AIP-3'],
            'status': 'backlog',
            'jiraDelivery': {**cards['AIP-3']['jiraDelivery'],
                             'storyExecutionApproved': True, 'requiresDecision': False},
        }, {**cards['AIP-2'], 'status': 'waiting_approval'}]
        with patch.object(worker.monitor, 'search', return_value=[epic]), \
             patch.object(worker.monitor, 'search_jql', side_effect=lambda c, q, limit=201:
                          stories if 'Epic Link' in q else []), \
             patch.object(worker.monitor, 'issue_detail', side_effect=lambda c, k: details[k]), \
             patch.object(worker.monitor, 'jira_lineage', side_effect=lambda c, k:
                          {'epic': epic, 'story': details[k]} if k != 'AIP-1' else {'epic': epic}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            _, awaiting_review = worker.build_plan(self.config, self.api, {}, 'next-run')
            self.assertFalse(any(c['action'] == 'dispatch' for c in awaiting_review))
            self.features[1]['status'] = 'verified'
            _, verified = worker.build_plan(self.config, self.api, {}, 'next-run')
        self.assertTrue(any(c['action'] == 'dispatch' and c['issueKey'] == 'AIP-3'
                            for c in verified))

    def test_dependency_refresh_preserves_manual_dependencies_and_drops_removed_jira_blockers(self):
        old = {'status': 'backlog', 'dependencies': ['manual-task', 'old-card'],
               'jiraDelivery': {'blockedBy': ['AIP-2']}}
        card = {'dependencies': ['new-card'], 'jiraDelivery': {'blockedBy': ['AIP-3']}}
        updates = worker.changes_for(old, card, 'run', ['old-card'])
        self.assertEqual(updates['dependencies'], ['manual-task', 'new-card'])
        self.assertNotIn('status', updates)
        self.assertNotIn('dependencies', worker.changes_for(
            {**old, 'dependencies': ['manual-task', 'new-card'],
             'jiraDelivery': {'blockedBy': ['AIP-3']}}, card, 'run', ['new-card']))

    def test_labelled_epic_does_not_claim_the_stories_subtasks(self):
        """Stories own their subtasks even when only the Epic has a routing label."""
        self.config.update(jiraProject='AIP', model='pi:litellm/worker', reasoningEffort='medium')
        epic = {'id': '10001', 'key': 'AIP-1', 'fields': {
            'summary': 'Epic scope', 'issuetype': {'name': 'Epic'}, 'labels': ['dodo'],
            'subtasks': [],
        }}
        story = {'key': 'AIP-2', 'fields': {
            'summary': 'Story', 'issuetype': {'name': 'Story'}, 'subtasks': [
                {'key': 'AIP-3',
                 'fields': {'summary': 'Backend', 'issuetype': {'name': 'Sub-task'}}},
            ],
        }}
        with patch.object(worker.monitor, 'issue_detail',
                          side_effect=lambda config, key: epic if key == 'AIP-1' else story), \
             patch.object(worker.monitor, 'jira_lineage', return_value={'epic': epic}), \
             patch.object(worker.monitor, 'search_jql',
                          side_effect=lambda config, jql, limit=200: [story] if 'Epic Link' in jql else []), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            card = worker.delivery_plan(self.config, 'AIP-1', [], 'dodo')['cards'][0]

        self.assertEqual(card['jiraSubtasks'], [])
        self.assertEqual(card['jiraDelivery']['subtaskKeys'], [])
        self.assertTrue(card['jiraDelivery']['requiresDecision'])

    def test_unsplit_story_never_gets_auto_decomposition_permission_or_auto_dispatch(self):
        self.config.update(jiraProject='AIP', model='pi:litellm/worker', reasoningEffort='medium')
        story = {'id': '10001', 'key': 'AIP-1', 'fields': {
            'summary': 'Unsplit work', 'issuetype': {'name': 'Story'}, 'labels': ['dodo'],
            'subtasks': [],
        }}
        with patch.object(worker.monitor, 'search', return_value=[story]), \
             patch.object(worker.monitor, 'issue_mode', return_value=('auto', 'dodo')), \
             patch.object(worker.monitor, 'issue_detail', return_value=story), \
             patch.object(worker.monitor, 'jira_lineage', return_value={'story': story}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            entries, changes = worker.build_plan(self.config, self.api, {}, 'run')
        self.assertIn('Manual decomposition only', entries[0]['card']['jiraExecutionInstructions'])
        self.assertNotIn('explicitly authorized', entries[0]['card']['jiraExecutionInstructions'])
        self.assertNotIn('dispatch', entries[0])
        self.assertTrue(changes[0]['delivery']['requiresDecision'])

    def test_normal_delivery_ignores_all_hierarchy_knobs_and_preserves_existing_branch(self):
        self.config.update(jiraProject='AIP', model='pi:litellm/worker', reasoningEffort='medium')
        story = {'id': '10001', 'key': 'AIP-1', 'fields': {
            'summary': 'Work', 'issuetype': {'name': 'Story'},
            'subtasks': [{'key': 'AIP-2', 'fields': {'summary': 'child'}}]}}
        features = [{'id': 'existing', 'jiraKey': 'AIP-1', 'branchName': 'legacy/aip-1'}]
        with patch.object(worker.monitor, 'issue_detail', return_value=story), \
             patch.object(worker.monitor, 'jira_lineage', return_value={'story': story}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', return_value='/existing/worktree'):
            for unit in ('story', 'task'):
                for scope in ('story', 'epic'):
                    result = worker.delivery_plan(dict(self.config, executionUnit=unit, worktreeScope=scope,
                                                      hierarchyImport={'executionUnit': unit, 'worktreeScope': scope}),
                                                  'AIP-1', features, 'dodo')
                    self.assertEqual(len(result['cards']), 1)
                    card = result['cards'][0]
                    self.assertEqual(card['branchName'], 'legacy/aip-1')
                    self.assertEqual(card['worktree'], '/existing/worktree')
                    self.assertEqual(card['planningMode'], 'skip')
                    self.assertFalse(card['jiraDelivery']['requiresDecision'])

    def test_new_sibling_reuses_epic_workspace_across_labels(self):
        self.config.update(jiraProject='AIP', model='pi:litellm/worker', reasoningEffort='medium')
        story = {'key': 'AIP-2', 'fields': {'summary': 'Child', 'issuetype': {'name': 'Story'}}}
        epic = {'key': 'AIP-1', 'fields': {'summary': 'Epic', 'issuetype': {'name': 'Epic'}}}
        features = [{'id': 'sibling', 'jiraKey': 'AIP-3', 'epicJiraKey': 'AIP-1',
                     'branchName': 'epic/aip-1-kaka'}]
        with patch.object(worker.monitor, 'issue_detail', return_value=story), \
             patch.object(worker.monitor, 'jira_lineage', return_value={'epic': epic, 'story': story}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            card = worker.delivery_plan(self.config, 'AIP-2', features, 'dodo')['cards'][0]
        self.assertEqual(card['branchName'], 'epic/aip-1-kaka')
        self.assertNotIn('worktreeMismatch', card['jiraDelivery'])

    def test_legacy_story_checkout_is_reported_without_relocating_work(self):
        self.config.update(jiraProject='AIP', model='pi:litellm/worker', reasoningEffort='medium')
        story = {'key': 'AIP-2', 'fields': {'summary': 'Child', 'issuetype': {'name': 'Story'}}}
        epic = {'key': 'AIP-1', 'fields': {'summary': 'Epic', 'issuetype': {'name': 'Epic'}}}
        features = [{'id': 'parent', 'jiraKey': 'AIP-1', 'branchName': 'jira/aip-1-kaka'},
                    {'id': 'child', 'jiraKey': 'AIP-2', 'epicJiraKey': 'AIP-1', 'branchName': 'story/aip-2-dodo'}]
        with patch.object(worker.monitor, 'issue_detail', return_value=story), \
             patch.object(worker.monitor, 'jira_lineage', return_value={'epic': epic, 'story': story}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            card = worker.delivery_plan(self.config, 'AIP-2', features, 'dodo')['cards'][0]
        self.assertEqual(card['branchName'], 'story/aip-2-dodo')
        self.assertEqual(card['jiraDelivery']['worktreeMismatch']['expectedBranch'], 'jira/aip-1-kaka')
        self.assertEqual(card['jiraKey'], 'AIP-2')

    def test_new_epic_workspace_does_not_depend_on_story_routing_label(self):
        self.config.update(jiraProject='AIP', model='pi:litellm/worker', reasoningEffort='medium', branchIncludeLabel=True)
        story = {'key': 'AIP-2', 'fields': {'summary': 'Child', 'issuetype': {'name': 'Story'}}}
        epic = {'key': 'AIP-1', 'fields': {'summary': 'Epic', 'issuetype': {'name': 'Epic'}}}
        with patch.object(worker.monitor, 'issue_detail', return_value=story), \
             patch.object(worker.monitor, 'jira_lineage', return_value={'epic': epic, 'story': story}), \
             patch.object(worker.monitor, 'worktree_path_for_branch', side_effect=lambda c, b, w: w):
            branches = [worker.delivery_plan(self.config, 'AIP-2', [], label)['cards'][0]['branchName']
                        for label in ['kaka', 'dodo']]
        self.assertEqual(branches[0], branches[1])

    def test_mismatched_workspace_is_not_dispatched(self):
        self.card['jiraDelivery'] = {'worktreeMismatch': {'expectedBranch': 'epic/aip-0'}}
        entries, changes = self.plan()
        self.assertNotIn('dispatch', entries[0])
        self.assertIn('Legacy Story worktree', changes[0]['reason'])

    def test_label_changes_preserve_card_and_branch_identity(self):
        self.features = [dict(self.card, id='jira-kaka-aip-1', branchName='jira/aip-1-kaka',
                              status='in_progress', providerSessionId='session')]
        entries, _ = self.plan()
        self.assertEqual(entries[0]['card']['id'], 'jira-kaka-aip-1')
        self.assertEqual(entries[0]['card']['branchName'], 'jira/aip-1-kaka')
        self.assertNotIn('dispatch', entries[0])

    def test_covered_cards_and_partial_cleanup_locks_are_not_reimported_or_dispatched(self):
        for fields in ({'archive': {'reason': 'deferred'}}, {'supersededBy': {'featureId': 'keeper'}}, {'consolidationPlanId': 'plan'}):
            self.features = [dict(self.card, **fields)]
            entries, changes = self.plan()
            self.assertEqual(entries, [])
            self.assertEqual(changes[0]['action'], 'skip')
            self.assertIn('consolidation', changes[0]['reason'])
            self.assertEqual(worker.changes_for(self.features[0], self.card, 'sync-run'), {})

    def test_active_task_gets_pending_requirements_not_overwritten_prompt_or_status(self):
        existing = dict(self.card, status='verified', description='human accepted scope',
                        providerSessionId='session', error='runtime problem',
                        jiraContext={'version': 'old'})
        updates = worker.changes_for(existing, self.card, 'run-2')
        self.assertEqual(updates['jiraPendingDescription'], 'new requirements')
        for key in ('status', 'error', 'summary', 'providerSessionId', 'description', 'acceptanceEvidence'):
            self.assertNotIn(key, updates)
        self.assertEqual(updates['jiraSyncHistory'][0]['runId'], 'run-2')

    def test_collapsed_or_removed_migrated_jobs_are_not_recreated(self):
        for status in ('collapsed_into_parent', 'missing_feature'):
            entries, changes = self.plan({'jobs': {'AIP-1': {'status': status}}})
            self.assertEqual(entries, [])
            self.assertEqual(changes[0]['action'], 'skip')

    def test_uncertain_dispatch_claim_is_not_replayed(self):
        entries, changes = self.plan({'jobs': {'AIP-1': {'status': 'dispatching', 'dispatchClaim': 'old'}}})
        self.assertNotIn('dispatch', entries[0])
        self.assertNotIn('dispatch', [c['action'] for c in changes])

    def test_development_delivery_is_not_dispatched_again_without_an_mr(self):
        entries, changes = self.plan({'jobs': {'AIP-1': {'status': 'development_reported'}}})
        self.assertNotIn('dispatch', entries[0])
        self.assertNotIn('dispatch', [c['action'] for c in changes])

    def test_snoozed_branch_still_imports_new_tasks_without_dispatching(self):
        directory = self.root / '.automaker'
        directory.mkdir()
        (directory / 'work-snoozes.json').write_text(json.dumps({
            self.card['branchName']: {'snoozedAt': '2026-09-21T00:00:00Z'},
        }))
        entries, changes = self.plan()
        self.assertEqual(len(entries), 1)
        self.assertNotIn('dispatch', entries[0])
        self.assertEqual([c['action'] for c in changes], ['create'])

    def test_completed_parent_dependency_required_before_dispatch(self):
        self.card['dependencies'] = ['parent']
        entries, _ = self.plan()
        self.assertNotIn('dispatch', entries[0])
        self.features = [{'id': 'parent', 'status': 'completed'}]
        entries, _ = self.plan()
        self.assertTrue(entries[0]['dispatch'])

    def test_identity_is_scoped_to_site_issue_id_and_project(self):
        one = worker.identity(self.config, '10001')
        self.assertEqual(one, worker.identity(dict(self.config, jiraUrl='https://jira.example/'), '10001'))
        self.assertNotEqual(one, worker.identity(dict(self.config, jiraUrl='https://other.example'), '10001'))
        self.assertNotEqual(one, worker.identity(dict(self.config, projectPath='/other'), '10001'))

    def test_duplicate_matches_are_reported_and_never_dispatched(self):
        self.features = [dict(self.card), dict(self.card, id='second')]
        entries, changes = self.plan()
        self.assertEqual(entries, [])
        self.assertEqual(changes[0]['action'], 'blocked')

    def test_disabled_auto_start_still_plans_import(self):
        self.config['autoStart'] = False
        entries, changes = self.plan()
        self.assertEqual(changes[0]['action'], 'create')
        self.assertNotIn('dispatch', entries[0])

    def test_claim_is_durable_before_uncertain_dispatch(self):
        entries, _ = self.plan()
        state = {'jobs': {}}
        state_path = self.root / 'state.json'
        def call(route, body):
            if route == 'features/list':
                return {'features': []}
            if route == 'auto-mode/status':
                return {'runningFeatures': []}
            if route == 'auto-mode/run-feature':
                saved = json.loads(state_path.read_text())
                self.assertEqual(saved['jobs']['AIP-1']['dispatchClaim'], 'run-1')
                raise TimeoutError('connection lost')
            return {'success': True}
        self.api.call.side_effect = call
        with patch.object(worker.monitor, 'ensure_worktree_for_branch'), \
             patch.object(worker.monitor, 'reviewer_for_assignee', return_value=(None, '', '', None)), \
             self.assertRaises(TimeoutError):
            worker.apply_plan(self.config, self.api, state, state_path, entries, 'run-1')
        self.assertEqual(json.loads(state_path.read_text())['jobs']['AIP-1']['status'], 'blocked')

    def test_only_sync_processes_human_approved_decomposition(self):
        self.config.update(jiraCommand='jira', jiraProgressMode='off', jiraHumanInputEnabled=False)
        cli = self.root / 'jira.yml'
        cli.write_text('server: https://jira.example\n')
        state_path = self.root / 'state.json'
        api = Mock()
        api.call.return_value = {'runningFeatures': []}
        with patch.dict(os.environ, {'JIRA_CONFIG_FILE': str(cli)}), \
             patch.object(worker, 'ManagedAPI', return_value=api), \
             patch.object(worker, 'build_plan', return_value=([], [])), \
             patch.object(worker.monitor, 'apply_decomposition_requests', return_value={'created': []}) as split:
            worker.run({'config': self.config, 'mode': 'preview', 'statePath': str(state_path), 'runId': 'preview'})
            split.assert_not_called()
            worker.run({'config': self.config, 'mode': 'sync', 'statePath': str(state_path), 'runId': 'sync'})
            split.assert_called_once()

    def test_old_receipt_cannot_reenter_writeback_after_a_new_reply(self):
        self.config.update(jiraCommand='jira', jiraProgressMode='completion', jiraHumanInputEnabled=False,
                           gitlabHost='gitlab.example')
        cli = self.root / 'jira.yml'
        cli.write_text('server: https://jira.example\n')
        receipt = self.root / 'jira-result.json'
        receipt.write_text(json.dumps({'runId': 'old-run', 'outcome': 'mr_created'}))
        state_path = self.root / 'state.json'
        state_path.write_text(json.dumps({'jobs': {'AIP-1': {
            'featureId': 'task', 'worktree': str(self.root), 'receiptRunId': 'old-run',
            'dispatchClaim': 'old-run', 'status': 'mr_reported',
            'result': {'runId': 'old-run', 'summary': 'old completed work'},
        }}}))
        api = Mock()
        api.call.side_effect = lambda route, body: (
            {'feature': {'executionRunId': 'new-reply-run'}} if route == 'features/get'
            else {'runningFeatures': []})
        with patch.dict(os.environ, {'JIRA_CONFIG_FILE': str(cli)}), \
             patch.object(worker, 'ManagedAPI', return_value=api), \
             patch.object(worker, 'build_plan', return_value=([], [])), \
             patch.object(worker.monitor, 'receipt_path_for', return_value=receipt), \
             patch.object(worker.monitor, 'sync_jira_progress') as writeback:
            worker.run({'config': self.config, 'mode': 'sync', 'statePath': str(state_path), 'runId': 'sync-run'})
        self.assertEqual(writeback.call_args.args[1]['jobs'], {})

    def test_already_taken_archive_never_enters_jira_comment_or_question_writeback(self):
        self.config.update(jiraCommand='jira', jiraProgressMode='completion',
                           jiraHumanInputEnabled=True, gitlabHost='gitlab.example')
        cli = self.root / 'jira.yml'
        cli.write_text('server: https://jira.example\n')
        state_path = self.root / 'state.json'
        state_path.write_text(json.dumps({'jobs': {'AIP-1': {
            'featureId': 'task', 'worktree': str(self.root), 'status': 'mr_reported',
            'result': {'runId': 'run', 'summary': 'completed'},
        }}}))
        api = Mock()
        api.call.side_effect = lambda route, body: (
            {'feature': {'executionRunId': 'run', 'status': 'completed',
                         'archive': {'reason': 'already_taken'}}}
            if route == 'features/get' else {'runningFeatures': []})
        with patch.dict(os.environ, {'JIRA_CONFIG_FILE': str(cli)}), \
             patch.object(worker, 'ManagedAPI', return_value=api), \
             patch.object(worker, 'build_plan', return_value=([], [])), \
             patch.object(worker.monitor, 'apply_decomposition_requests'), \
             patch.object(worker.monitor, 'sync_jira_progress') as progress, \
             patch.object(worker.monitor, 'sync_human_input') as questions:
            worker.run({'config': self.config, 'mode': 'sync',
                        'statePath': str(state_path), 'runId': 'sync-run'})
        self.assertEqual(progress.call_args.args[1]['jobs'], {})
        self.assertEqual(questions.call_args.args[1]['jobs'], {})


if __name__ == '__main__':
    unittest.main()
