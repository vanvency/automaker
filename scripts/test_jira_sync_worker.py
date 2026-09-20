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

    def test_preview_is_read_only_and_identifies_proposed_dispatch(self):
        entries, changes = self.plan()
        self.assertEqual([c['action'] for c in changes], ['create', 'dispatch'])
        self.assertTrue(entries[0]['card']['id'].startswith('jira-'))
        self.assertTrue(all(call.args[0] in ('features/list', 'auto-mode/status') for call in self.api.call.call_args_list))
        self.assertFalse((self.root / 'wt').exists())

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
        self.assertIn('do not create Automaker child features'.lower(), ' '.join(card['description'].lower().split()))
        self.assertEqual(changes[0]['delivery']['issueKey'], 'AIP-1')

    def test_labelled_epic_scans_unlabelled_subtasks_of_its_stories(self):
        """Only the epic is labelled; its children are read from Jira links."""
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

        self.assertEqual([subtask['key'] for subtask in card['jiraSubtasks']], ['AIP-3'])
        self.assertEqual(card['jiraDelivery']['subtaskKeys'], ['AIP-3'])
        self.assertFalse(card['jiraDelivery']['requiresDecision'])
        self.assertNotIn('has no Jira subtasks', card['description'])

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
        self.assertIn('Manual decomposition only', entries[0]['card']['description'])
        self.assertNotIn('explicitly authorized', entries[0]['card']['description'])
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


if __name__ == '__main__':
    unittest.main()
