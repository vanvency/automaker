import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('jira_monitor', Path(__file__).with_name('jira-monitor.py'))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = {'jiraProject': 'AIP', 'jiraLabel': 'kaka', 'dispatchEnabled': True,
                       'projectPath': str(self.root), 'gitlabHost': 'gitblue.transwarp.io',
                       'jiraUrl': 'https://jira.transwarp.io', 'model': 'codex-gpt-5.3-codex',
                       'reasoningEffort': 'medium', 'jiraCommand': '/usr/local/bin/jira',
                       'jiraLabels': {'autoStart': ['dodo'], 'manualStart': ['kaka']}}
        self.issue = {'key': 'AIP-123', 'fields': {'summary': 'Example', 'labels': ['kaka'],
                      'resolution': None, 'status': {'statusCategory': {'key': 'new'}}}}
        self.state = {'jobs': {}}
        self.state_path = self.root / 'state.json'

    def test_empty_jira_is_distinct_from_auth_error(self):
        empty = subprocess.CompletedProcess([], 1, '\n', 'No result found for given query in project "AIP"')
        self.assertEqual(monitor.parse_jira_page(empty), [])
        auth = subprocess.CompletedProcess([], 1, '', '401 unauthorized')
        with self.assertRaises(RuntimeError):
            monitor.parse_jira_page(auth)
        malformed = subprocess.CompletedProcess([], 0, '{}', '')
        with self.assertRaises(ValueError):
            monitor.parse_jira_page(malformed)

    def split_feature(self):
        return {'id': 'jira-dodo-aip-1', 'jiraKey': 'AIP-1', 'jiraLabels': ['dodo'],
                'decompositionRequest': {
                    'status': 'creating-jira',
                    'tasks': [{'id': 'T001', 'description': 'Build the parser', 'filePath': 'src/p.ts'},
                              {'id': 'T002', 'description': 'Wire the parser'}]}}

    def test_approved_split_creates_jira_subtasks_then_dispatches(self):
        calls = []

        def call(route, body=None):
            calls.append((route, body))
            if route == 'features/list':
                return {'success': True, 'features': [self.split_feature()]}
            if route == 'features/herdr-dispatch':
                return {'success': True, 'status': 'executed'}
            return {'success': True}

        api = Mock()
        api.call.side_effect = call
        created = iter([json.dumps({'key': 'AIP-11'}), json.dumps({'key': 'AIP-12'})])
        with patch.object(monitor, 'checked', side_effect=lambda *a, **k: next(created)) as checked:
            result = monitor.apply_decomposition_requests(self.config, self.state, api)

        commands = [call.args[0] for call in checked.call_args_list]
        self.assertEqual(len(commands), 2)
        for command in commands:
            self.assertIn('issue', command)
            self.assertIn('create', command)
            self.assertEqual(command[command.index('-P') + 1], 'AIP-1')
            self.assertEqual(command[command.index('-t') + 1], 'Sub-task')
            self.assertIn('dodo', command)

        updates = [body['updates'] for route, body in calls if route == 'features/update']
        self.assertEqual([entry['key'] for entry in updates[-1]['jiraSubtasks']],
                         ['AIP-11', 'AIP-12'])
        self.assertEqual(updates[-1]['decompositionRequest']['status'], 'created')
        self.assertEqual([route for route, _ in calls][-1], 'features/herdr-dispatch')
        self.assertEqual(result['created'][0]['created'], ['AIP-11', 'AIP-12'])

    def test_partial_subtask_creation_is_recorded_for_a_human(self):
        calls = []

        def call(route, body=None):
            calls.append((route, body))
            if route == 'features/list':
                return {'success': True, 'features': [self.split_feature()]}
            return {'success': True}

        api = Mock()
        api.call.side_effect = call
        answers = iter([json.dumps({'key': 'AIP-11'}), RuntimeError('jira exploded')])

        def answer(*_args, **_kwargs):
            value = next(answers)
            if isinstance(value, Exception):
                raise value
            return value

        with patch.object(monitor, 'checked', side_effect=answer):
            monitor.apply_decomposition_requests(self.config, self.state, api)

        updates = [body['updates'] for route, body in calls if route == 'features/update']
        self.assertEqual(updates[-1]['decompositionRequest']['status'], 'failed')
        self.assertEqual(updates[-1]['decompositionRequest']['createdKeys'], ['AIP-11'])
        self.assertIn('jira exploded', updates[-1]['decompositionRequest']['error'])
        self.assertNotIn('features/herdr-dispatch', [route for route, _ in calls])

    def test_split_without_a_jira_parent_is_reported_not_guessed(self):
        calls = []

        def call(route, body=None):
            calls.append((route, body))
            if route == 'features/list':
                card = self.split_feature()
                card.pop('jiraKey')
                return {'success': True, 'features': [card]}
            return {'success': True}

        api = Mock()
        api.call.side_effect = call
        with patch.object(monitor, 'checked') as checked:
            monitor.apply_decomposition_requests(self.config, self.state, api)

        checked.assert_not_called()
        updates = [body['updates'] for route, body in calls if route == 'features/update']
        self.assertEqual(updates[-1]['decompositionRequest']['status'], 'failed')
        self.assertIn('no Jira issue', updates[-1]['decompositionRequest']['error'])

    def test_proposed_requests_are_left_alone(self):
        api = Mock()
        api.call.return_value = {'success': True, 'features': [dict(
            self.split_feature(),
            decompositionRequest={'status': 'proposed', 'tasks': []})]}
        with patch.object(monitor, 'checked') as checked:
            monitor.apply_decomposition_requests(self.config, self.state, api)
        checked.assert_not_called()
        self.assertNotIn('features/update', [call.args[0] for call in api.call.call_args_list])

    def test_created_subtasks_inherit_the_card_label(self):
        feature = self.split_feature()
        self.assertEqual(monitor.automaker_split_labels(self.config, feature), ['dodo'])
        # Automaker-invented work waits for a human, so it falls back to the label
        # that does not auto-start.
        feature['jiraLabels'] = []
        self.assertEqual(monitor.automaker_split_labels(self.config, feature), ['kaka'])

    def test_only_matching_unresolved_issues(self):
        self.assertTrue(monitor.eligible(self.issue, self.config))
        for resolution in [{'name': ''}, {'name': ' '}, {}]:
            issue = dict(self.issue, fields=dict(self.issue['fields'], resolution=resolution))
            self.assertTrue(monitor.eligible(issue, self.config))
        for changes in [{'labels': ['other']}, {'resolution': {'name': 'Fixed'}},
                        {'resolution': {'id': '1', 'name': ''}},
                        {'status': {'statusCategory': {'key': 'done'}}}]:
            issue = dict(self.issue, fields=dict(self.issue['fields'], **changes))
            self.assertFalse(monitor.eligible(issue, self.config))
        self.assertFalse(monitor.eligible(dict(self.issue, key='OTHER-123'), self.config))

    def test_parent_issues_are_dispatched(self):
        parent = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Epic', 'subtask': False}, Subtasks=[]))
        self.assertTrue(monitor.eligible(parent, self.config))

        story = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Story', 'subtask': False}, Subtasks=[]))
        self.assertTrue(monitor.eligible(story, self.config))

        task = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Task', 'subtask': False}, Subtasks=[]))
        self.assertTrue(monitor.eligible(task, self.config))

    def test_parent_prompt_requires_manual_decomposition(self):
        epic = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Epic', 'subtask': False},
            Subtasks=[]))
        config = dict(self.config, apiKeyFile='/tmp/api-key', automakerUrl='http://127.0.0.1:3008')
        prompt = monitor.task_description(epic, config, '/tmp/wt', 'jira/aip-123-kaka')
        # Automaker must never decompose on its own: Jira subtasks are the source
        # of truth and an Automaker-side split needs an explicit human decision.
        self.assertNotIn('Autonomous decomposition', prompt)
        self.assertNotIn('First create executable Automaker child features', prompt)
        self.assertIn('Manual decomposition only', prompt)
        self.assertIn('"outcome": "needs_input"', prompt)
        self.assertIn('Split', prompt)
        self.assertIn(
            'Do not create MRs and do not call /api/features/create from this session', prompt
        )
        self.assertIn('jira/aip-123-kaka', prompt)
        self.assertNotIn('parentsPendingSplit', prompt)

    def test_non_parent_prompt_has_no_decomposition_directive(self):
        task = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Task', 'subtask': False},
            Subtasks=[]))
        prompt = monitor.task_description(task, self.config, '/tmp/wt', 'jira/aip-123-kaka')
        self.assertNotIn('Autonomous decomposition', prompt)
        self.assertNotIn('Manual decomposition only', prompt)

    def test_prompt_hands_off_development_without_requiring_merge_requests(self):
        task = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Task', 'subtask': False},
            Subtasks=[]))
        prompt = monitor.task_description(task, self.config, '/tmp/wt', 'jira/aip-123-kaka')
        self.assertIn('Development completion does not', prompt)
        self.assertIn('Do not create/update MRs', prompt)
        self.assertIn('development_complete', prompt)

    def test_development_receipt_requires_checks_but_not_mrs(self):
        log = self.root / 'tests.log'
        log.write_text('checks passed')
        receipt = {
            'issueKey': 'AIP-123', 'outcome': 'development_complete',
            'tests': [{'command': 'npm test', 'exitCode': 0}],
            'testLog': str(log), 'mergeRequests': [], 'blockers': [],
        }
        self.assertTrue(monitor.validate_receipt(
            receipt, 'AIP-123', str(self.root), self.config['gitlabHost']))
        for updates in ({'blockers': ['Missing authorization check']},
                        {'tests': []}, {'issueKey': 'AIP-999'},
                        {'mergeRequests': ['https://unrelated.example/mr/1']},
                        {'tests': [{'command': 'npm test', 'exitCode': 1}]}):
            self.assertFalse(monitor.validate_receipt(
                dict(receipt, **updates), 'AIP-123', str(self.root), self.config['gitlabHost']))

    def test_prompt_requires_changed_project_mr_metadata(self):
        task = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Task', 'subtask': False},
            Subtasks=[]))
        prompt = monitor.task_description(task, self.config, '/tmp/wt', 'jira/aip-123-kaka')
        self.assertIn('changedProjects', prompt)
        self.assertIn('mrUrl', prompt)
        self.assertIn('one entry per changed repository', prompt)

    def test_prompt_keeps_jira_content_without_monitor_routing_narration(self):
        task = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Task', 'subtask': False},
            Subtasks=[]))
        prompt = monitor.task_description(task, self.config, '/tmp/wt', 'task/aip-123')
        # The dispatched prompt carries Jira requirements plus the delivery
        # contract; monitor-internal routing state (dodo/kaka labels) and
        # workflow restatements belong to the monitor, not the agent prompt.
        self.assertIn('Implement Jira AIP-123', prompt)
        self.assertIn('Initial Jira snapshot', prompt)
        self.assertNotIn('authorized monitoring', prompt)
        self.assertNotIn('kaka tasks wait', prompt)
        self.assertNotIn('label kaka', prompt)
        self.assertNotIn('prepared by the monitor', prompt)

    def test_delivery_contract_is_shared_and_feature_scoped(self):
        task = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Task', 'subtask': False},
            Subtasks=[]))
        prompt = monitor.task_description(task, self.config, '/tmp/wt', 'task/aip-123')
        # One contract serves the Jira prompt and the legacy -child- backfill in
        # run-all-features.py; only the receipt path differs per card.
        self.assertIn(
            monitor.delivery_directive('AIP-123', '/tmp/wt', 'task/aip-123'), prompt)
        self.assertIn(monitor.DELIVERY_MARKER, prompt)
        child = monitor.delivery_directive(
            'AIP-123', '/tmp/wt', 'task/aip-123', feature_id='aip-123-child-1')
        self.assertIn(
            '/tmp/wt/.automaker/jira/aip-123-child-1/jira-result.json', child)

    def test_receipt_path_is_feature_scoped_with_legacy_fallback(self):
        worktree = self.root / '.worktrees/aip-123-kaka'
        legacy = worktree / '.automaker/jira-result.json'
        legacy.parent.mkdir(parents=True)
        self.assertEqual(monitor.receipt_path_for(worktree, 'jira-kaka-aip-123'), legacy)

        scoped = worktree / '.automaker/jira/jira-kaka-aip-123/jira-result.json'
        scoped.parent.mkdir(parents=True)
        scoped.write_text('{}')
        self.assertEqual(monitor.receipt_path_for(worktree, 'jira-kaka-aip-123'), scoped)

    def test_dodo_is_auto_start_and_kaka_is_manual(self):
        self.config['jiraLabels'] = {'autoStart': ['dodo'], 'manualStart': ['kaka']}
        dodo = dict(self.issue, fields=dict(self.issue['fields'], labels=['dodo']))
        kaka = dict(self.issue, fields=dict(self.issue['fields'], labels=['kaka']))
        other = dict(self.issue, fields=dict(self.issue['fields'], labels=['other']))
        self.assertEqual(monitor.issue_mode(dodo, self.config), ('auto', 'dodo'))
        self.assertEqual(monitor.issue_mode(kaka, self.config), ('manual', 'kaka'))
        self.assertIsNone(monitor.issue_mode(other, self.config))

    def test_manual_label_is_prepared_without_running(self):
        self.config['jiraLabels'] = {'autoStart': ['dodo'], 'manualStart': ['kaka']}
        api = Mock()
        api.call.return_value = {'runningCount': 0, 'runningFeatures': []}
        with patch.object(monitor, 'dispatch') as dispatch:
            monitor.tick(self.config, self.state, self.state_path, api, [self.issue])
        dispatch.assert_called_once()
        self.assertFalse(dispatch.call_args.kwargs['auto_start'])
        self.assertEqual(dispatch.call_args.kwargs['label'], 'kaka')

    def test_auto_label_starts_dodo(self):
        self.config['jiraLabels'] = {'autoStart': ['dodo'], 'manualStart': ['kaka']}
        dodo = dict(self.issue, fields=dict(self.issue['fields'], labels=['dodo']))
        api = Mock()
        api.call.return_value = {'runningCount': 0, 'runningFeatures': []}
        with patch.object(monitor, 'dispatch') as dispatch:
            monitor.tick(self.config, self.state, self.state_path, api, [dodo])
        dispatch.assert_called_once()
        self.assertTrue(dispatch.call_args.kwargs['auto_start'])
        self.assertEqual(dispatch.call_args.kwargs['label'], 'dodo')

    def test_manual_dispatch_leaves_feature_ready(self):
        # Branch and worktree are named after the Jira issue type (no issueType
        # in this fixture, which falls back to the generic `feat` prefix).
        (self.root / '.worktrees/feat-aip-123').mkdir(parents=True)
        api = Mock()
        api.call.return_value = {'success': True}
        with patch.object(monitor, 'checked'):
            monitor.dispatch(self.issue, self.config, self.state, self.state_path, api,
                             auto_start=False, label='kaka')
        self.assertEqual(self.state['jobs']['AIP-123']['status'], 'ready')
        self.assertEqual(self.state['jobs']['AIP-123']['branch'], 'feat/aip-123')
        self.assertEqual(self.state['jobs']['AIP-123']['worktree'],
                         str(self.root / '.worktrees/feat-aip-123'))
        routes = [call.args[0] for call in api.call.call_args_list]
        self.assertIn('features/create', routes)
        self.assertNotIn('auto-mode/run-feature', routes)

    def test_duplicate_and_blocked_jobs_never_redispatched(self):
        self.state['jobs']['AIP-123'] = {'status': 'blocked'}
        api = Mock()
        api.call.return_value = {'runningCount': 0, 'runningFeatures': []}
        with patch.object(monitor, 'dispatch') as dispatch:
            monitor.tick(self.config, self.state, self.state_path, api, [self.issue])
            dispatch.assert_not_called()

    def test_busy_automaker_defers_new_work(self):
        api = Mock()
        api.call.return_value = {'runningCount': 1, 'runningFeatures': ['manual-job']}
        # Manual imports may prepare cards while busy; automatic execution must wait.
        self.issue['fields']['labels'] = ['dodo']
        with patch.object(monitor, 'dispatch') as dispatch:
            monitor.tick(self.config, self.state, self.state_path, api, [self.issue])
            dispatch.assert_not_called()

    def test_only_one_issue_dispatched_per_tick(self):
        api = Mock()
        api.call.return_value = {'runningCount': 0, 'runningFeatures': []}
        with patch.object(monitor, 'dispatch') as dispatch:
            monitor.tick(self.config, self.state, self.state_path, api,
                         [self.issue, dict(self.issue, key='AIP-124')])
            dispatch.assert_called_once()
            self.assertEqual(dispatch.call_args.args[0]['key'], 'AIP-123')

    def test_one_orphaned_job_does_not_kill_the_poll(self):
        dispatched_at = '2026-09-19T00:00:00+00:00'
        state = {'jobs': {
            'AIP-1': {'status': 'running', 'featureId': 'gone', 'worktree': str(self.root / 'wt'),
                      'dispatchedAt': dispatched_at},
            'AIP-2': {'status': 'running', 'featureId': 'alive', 'worktree': str(self.root / 'wt'),
                      'dispatchedAt': dispatched_at},
        }}

        def call(route, body=None):
            if route == 'features/get':
                if body['featureId'] == 'gone':
                    raise urllib.error.HTTPError('http://x/api/features/get', 404, 'Not Found', {}, None)
                return {'success': True, 'feature': {'id': 'alive', 'status': 'running'}}
            return {'runningCount': 0, 'runningFeatures': []}

        api = Mock()
        api.call.side_effect = call
        monitor.reconcile(self.config, state, api)

        self.assertEqual(state['jobs']['AIP-1']['status'], 'missing_feature')
        self.assertEqual(state['missingFeatures']['AIP-1'], 'gone')
        self.assertNotEqual(state['jobs']['AIP-2']['status'], 'missing_feature')

    def test_uncertain_dispatch_is_persisted_and_not_retried(self):
        (self.root / '.worktrees/feat-aip-123').mkdir(parents=True)
        api = Mock()
        def call(route, body):
            if route == 'auto-mode/run-feature':
                persisted = json.loads(self.state_path.read_text())
                self.assertEqual(persisted['jobs']['AIP-123']['status'], 'dispatching')
                raise TimeoutError('request outcome unknown')
            return {'success': True}
        api.call.side_effect = call
        with patch.object(monitor, 'checked'):
            monitor.dispatch(self.issue, self.config, self.state, self.state_path, api)
        self.assertEqual(self.state['jobs']['AIP-123']['status'], 'blocked')
        self.assertIn('unknown', self.state['jobs']['AIP-123']['error'])

    def test_complete_without_test_mr_receipt_is_blocked(self):
        self.state['jobs']['AIP-123'] = {'status': 'running', 'featureId': 'job',
                                        'worktree': str(self.root), 'dispatchedAt': monitor.now()}
        api = Mock()
        api.call.side_effect = [{'runningCount': 0, 'runningFeatures': []},
                                {'feature': {'status': 'completed'}}]
        monitor.reconcile(self.config, self.state, api)
        self.assertEqual(self.state['jobs']['AIP-123']['status'], 'blocked')

    def test_blocked_receipt_repairs_false_completion(self):
        self.state['jobs']['AIP-123'] = {'status': 'blocked', 'featureId': 'job',
            'result': {'outcome': 'blocked', 'blockers': ['Missing product rule']}}
        api = Mock()
        api.call.side_effect = [{'feature': {'status': 'verified'}}, {'success': True}]
        monitor.repair_blocked_feature_status(self.config, self.state, api)
        self.assertEqual(api.call.call_args.args[0], 'features/update')
        self.assertEqual(api.call.call_args.args[1]['updates']['status'], 'backlog')
        self.assertEqual(api.call.call_args.args[1]['updates']['error'], 'Missing product rule')

    def test_human_completed_feature_is_not_reopened(self):
        worktree = self.root / '.worktrees/aip-123-kaka'
        (worktree / '.automaker').mkdir(parents=True)
        receipt = {'issueKey': 'AIP-123', 'outcome': 'mr_created',
                   'blockers': ['E2E deployment validation intentionally omitted']}
        (worktree / '.automaker/jira-result.json').write_text(json.dumps(receipt))
        self.state['jobs']['AIP-123'] = {'status': 'mr_reported', 'featureId': 'job',
                                         'worktree': str(worktree), 'result': receipt}
        api = Mock()
        api.call.return_value = {'feature': {'status': 'completed',
                                             'completionSource': 'human'}}
        monitor.historical_partial_delivery_repair(self.config, self.state, api)
        self.assertEqual(self.state['jobs']['AIP-123']['status'], 'blocked')
        self.assertEqual(api.call.call_args.args[0], 'features/get')
        self.assertEqual(self.state['jobs']['AIP-123'].get('featureStatus'), None)

    def test_historical_partial_delivery_is_repaired(self):
        worktree = self.root / '.worktrees/aip-123-kaka'
        (worktree / '.automaker').mkdir(parents=True)
        receipt = {'issueKey': 'AIP-123', 'outcome': 'mr_created',
                   'blockers': ['Epic §4C remains unimplemented']}
        (worktree / '.automaker/jira-result.json').write_text(json.dumps(receipt))
        self.state['jobs']['AIP-123'] = {'status': 'mr_reported', 'featureId': 'job',
                                         'worktree': str(worktree), 'result': receipt}
        api = Mock()
        api.call.side_effect = [{'feature': {'status': 'verified'}}, {'success': True}]
        monitor.historical_partial_delivery_repair(self.config, self.state, api)
        job = self.state['jobs']['AIP-123']
        self.assertEqual(job['status'], 'blocked')
        self.assertEqual(job['error'], 'Epic §4C remains unimplemented')
        self.assertEqual(job['featureStatus'], 'backlog')
        self.assertEqual(api.call.call_args.args[0], 'features/update')

    def test_progress_sync_posts_once_and_verifies(self):
        self.config.update(jiraProgressMode='completion', jiraCommand='jira')
        self.state['jobs']['AIP-123'] = {'status': 'mr_reported', 'result': {'summary': 'Done'}}
        posted = []
        def checked(args, *unused):
            if 'add' in args:
                posted.append(Path(args[args.index('--template') + 1]).read_text())
                return ''
            issue = dict(self.issue, fields=dict(self.issue['fields']))
            issue['fields']['comment'] = {'comments': [{'body': b.replace('-', '\\-')} for b in posted]}
            return json.dumps(issue)
        with patch.object(monitor, 'checked', side_effect=checked):
            monitor.sync_jira_progress(self.config, self.state)
            monitor.sync_jira_progress(self.config, self.state)
            self.assertEqual(len(posted), 1)
            self.state['jobs']['AIP-123'].pop('jiraProgressMarker')
            monitor.sync_jira_progress(self.config, self.state)
            self.assertEqual(len(posted), 1)

    def test_progress_sync_failure_does_not_claim_success(self):
        self.config.update(jiraProgressMode='completion', jiraCommand='jira')
        job = {'status': 'mr_reported'}
        self.state['jobs']['AIP-123'] = job
        with patch.object(monitor, 'checked', side_effect=RuntimeError('Network error')):
            monitor.sync_jira_progress(self.config, self.state)
        self.assertNotIn('jiraProgressMarker', job)
        self.assertIn('Network error', job['jiraSyncError'])

    def test_completion_mode_ignores_intermediate_states(self):
        self.config.update(jiraProgressMode='completion', jiraCommand='jira')
        self.state['jobs']['AIP-123'] = {'status': 'running'}
        self.state['jobs']['AIP-124'] = {'status': 'blocked'}
        with patch.object(monitor, 'checked') as checked:
            monitor.sync_jira_progress(self.config, self.state)
            checked.assert_not_called()

    def test_search_error_still_reconciles_dispatched_jobs(self):
        worktree = self.root / '.worktrees/aip-123-kaka'
        (worktree / '.automaker').mkdir(parents=True)
        log = worktree / 'test.log'
        log.write_text('ok\n')
        result = {'issueKey': 'AIP-123', 'outcome': 'mr_created',
                  'tests': [{'command': 'test', 'exitCode': 0}], 'testLog': str(log),
                  'mergeRequests': ['https://gitblue.transwarp.io/g/r/-/merge_requests/1']}
        (worktree / '.automaker/jira-result.json').write_text(json.dumps(result))
        self.state['jobs']['AIP-123'] = {'status': 'blocked', 'featureId': 'job',
                                         'worktree': str(worktree), 'dispatchedAt': monitor.now()}
        api = Mock()
        api.call.side_effect = [{'runningCount': 0, 'runningFeatures': []},
                                {'feature': {'status': 'verified'}}]
        with patch.object(monitor, 'sync_jira_progress'):
            monitor.tick(self.config, self.state, self.state_path, api, [],
                         search_error='jira 403')
        self.assertEqual(self.state['jobs']['AIP-123']['status'], 'mr_reported')
        self.assertIn('jira 403', self.state['lastError'])

    def test_needs_input_receipt_marks_job(self):
        worktree = self.root / '.worktrees/aip-123-kaka'
        (worktree / '.automaker').mkdir(parents=True)
        result = {'issueKey': 'AIP-123', 'outcome': 'needs_input',
                  'questions': [{'question': 'A or B?', 'options': ['A', 'B']}]}
        (worktree / '.automaker/jira-result.json').write_text(json.dumps(result))
        self.state['jobs']['AIP-123'] = {'status': 'running', 'featureId': 'job',
                                         'worktree': str(worktree), 'dispatchedAt': monitor.now()}
        api = Mock()
        api.call.side_effect = [{'runningCount': 0, 'runningFeatures': []},
                                {'feature': {'status': 'backlog'}},
                                {'success': True}]
        monitor.reconcile(self.config, self.state, api)
        self.assertEqual(self.state['jobs']['AIP-123']['status'], 'needs_input')

    def test_human_input_notifies_reporter(self):
        self.config.update(jiraHumanInputEnabled=True, jiraMonitorUser='haojun.fan',
                           jiraCommand='jira')
        job = {'status': 'needs_input', 'featureId': 'jira-kaka-aip-123',
               'result': {'questions': [{'question': 'A or B?', 'options': ['A', 'B'],
                                         'context': 'Need a product choice'}]}}
        self.state['jobs']['AIP-123'] = job
        posted = []
        issue = {'fields': {'reporter': {'name': 'tingyu.yang'},
                            'comment': {'comments': []}}}
        def checked(args, *unused):
            if 'add' in args:
                posted.append(Path(args[args.index('--template') + 1]).read_text())
                issue['fields']['comment']['comments'] = [
                    {'id': '1', 'body': posted[0], 'created': '2026-09-11T10:00:00.000+0800'}]
                return ''
            return json.dumps(issue)
        api = Mock()
        api.call.return_value = {'success': True}
        with patch.object(monitor, 'checked', side_effect=checked):
            monitor.sync_human_input(self.config, self.state, self.state_path, api)
        self.assertIn('[~tingyu.yang]', posted[0])
        self.assertIn('A or B?', posted[0])
        self.assertTrue(job.get('questionMarker'))
        self.assertIn('features/update', [call.args[0] for call in api.call.call_args_list])

    def test_human_input_resumes_on_jira_reply(self):
        self.config.update(jiraHumanInputEnabled=True, jiraMonitorUser='haojun.fan',
                           jiraCommand='jira')
        marker = '[automaker-question:AIP-123:abc123]'
        job = {'status': 'needs_input', 'featureId': 'jira-kaka-aip-123',
               'questionMarker': marker, 'questionCommentId': '1',
               'questionCreated': '2026-09-11T10:00:00.000+0800',
               'result': {'questions': [{'question': 'A or B?', 'options': ['A', 'B']}]}}
        self.state['jobs']['AIP-123'] = job
        issue = {'fields': {'reporter': {'name': 'tingyu.yang'}, 'comment': {'comments': [
            {'id': '1', 'body': marker, 'created': '2026-09-11T10:00:00.000+0800',
             'author': {'name': 'haojun.fan'}},
            {'id': '2', 'body': 'Use option B.', 'created': '2026-09-11T10:05:00.000+0800',
             'author': {'name': 'tingyu.yang'}},
        ]}}}
        api = Mock()
        api.call.return_value = {'success': True}
        with patch.object(monitor, 'checked', return_value=json.dumps(issue)):
            monitor.sync_human_input(self.config, self.state, self.state_path, api)
        routes = [call.args[0] for call in api.call.call_args_list]
        self.assertIn('auto-mode/follow-up-feature', routes)
        self.assertEqual(job['status'], 'running')
        self.assertEqual(job['answer'], 'Use option B.')

    def test_receipt_allows_documented_baseline_failures(self):
        log = self.root / 'test.log'
        log.write_text('ok\n')
        result = {'issueKey': 'AIP-123', 'outcome': 'mr_created',
                  'tests': [{'command': 'vitest run', 'exitCode': 0},
                            {'command': 'tsc --noEmit (16 既有错误，无新增)', 'exitCode': 2}],
                  'testLog': str(log),
                  'mergeRequests': ['https://gitblue.transwarp.io/g/r/-/merge_requests/1']}
        self.assertTrue(monitor.validate_receipt(
            result, 'AIP-123', self.root, self.config['gitlabHost']))

    def test_receipt_with_blockers_is_not_complete(self):
        log = self.root / 'test.log'
        log.write_text('ok\n')
        result = {'issueKey': 'AIP-123', 'outcome': 'mr_created',
                  'tests': [{'command': 'test', 'exitCode': 0}], 'testLog': str(log),
                  'mergeRequests': ['https://gitblue.transwarp.io/g/r/-/merge_requests/1'],
                  'blockers': ['Epic §4B and §4C remain unimplemented']}
        self.assertFalse(monitor.validate_receipt(
            result, 'AIP-123', self.root, self.config['gitlabHost']))

    def test_mr_receipt_with_blockers_preserves_work_as_waiting_approval(self):
        worktree = self.root / '.worktrees/aip-123-kaka'
        (worktree / '.automaker').mkdir(parents=True)
        log = worktree / 'test.log'
        log.write_text('ok\n')
        result = {'issueKey': 'AIP-123', 'outcome': 'mr_created',
                  'tests': [{'command': 'test', 'exitCode': 0}], 'testLog': str(log),
                  'mergeRequests': ['https://gitblue.transwarp.io/g/r/-/merge_requests/1'],
                  'blockers': ['Epic §4B remains unimplemented', 'Backend API pending']}
        (worktree / '.automaker/jira-result.json').write_text(json.dumps(result))
        self.state['jobs']['AIP-123'] = {'status': 'running', 'featureId': 'job',
                                         'worktree': str(worktree),
                                         'dispatchedAt': monitor.now()}
        api = Mock()
        api.call.side_effect = [{'runningCount': 0, 'runningFeatures': []},
                                {'feature': {'status': 'backlog'}},
                                {'success': True}]
        monitor.reconcile(self.config, self.state, api)
        job = self.state['jobs']['AIP-123']
        self.assertEqual(job['status'], 'blocked')
        self.assertEqual(job['error'], 'Epic §4B remains unimplemented; Backend API pending')
        self.assertEqual(job['featureStatus'], 'waiting_approval')
        self.assertEqual(api.call.call_count, 3)

    def test_mr_receipt_with_invalid_delivery_still_goes_to_backlog(self):
        worktree = self.root / '.worktrees/aip-123-kaka'
        (worktree / '.automaker').mkdir(parents=True)
        result = {'issueKey': 'AIP-123', 'outcome': 'mr_created',
                  'tests': [], 'mergeRequests': [],
                  'blockers': ['Backend API pending']}
        (worktree / '.automaker/jira-result.json').write_text(json.dumps(result))
        self.state['jobs']['AIP-123'] = {'status': 'running', 'featureId': 'job',
                                         'worktree': str(worktree),
                                         'dispatchedAt': monitor.now()}
        api = Mock()
        api.call.side_effect = [{'runningCount': 0, 'runningFeatures': []},
                                {'feature': {'status': 'backlog'}}]
        monitor.reconcile(self.config, self.state, api)
        job = self.state['jobs']['AIP-123']
        self.assertEqual(job['status'], 'blocked')
        self.assertEqual(job.get('featureStatus'), 'backlog')
        self.assertEqual(api.call.call_count, 2)

    def test_receipt_requires_tests_log_and_gitlab_mr_url(self):
        log = self.root / 'test.log'
        log.write_text('regression test passed\n')
        result = {'issueKey': 'AIP-123', 'outcome': 'mr_created',
                  'tests': [{'command': 'test', 'exitCode': 0}], 'testLog': str(log),
                  'mergeRequests': ['https://gitblue.transwarp.io/group/repo/-/merge_requests/12']}
        validate = lambda r: monitor.validate_receipt(r, 'AIP-123', self.root, self.config['gitlabHost'])
        self.assertTrue(validate(result))
        self.assertTrue(validate(dict(
            result, mergeRequests=[result['mergeRequests'][0].replace('https://', 'http://')])))
        self.assertFalse(validate(dict(result, tests=[{'command': 'test', 'exitCode': 1}])))
        self.assertFalse(validate(dict(result, mergeRequests=['https://example.com/merge_requests/12'])))
        self.assertFalse(validate(dict(result, mergeRequests=[])))
        self.assertFalse(validate(dict(result, testLog='/etc/passwd')))

    def test_issue_subtasks_reads_both_endpoint_shapes(self):
        listed = {'Subtasks': [
            {'key': 'AIP-124', 'fields': {'summary': 'Backend', 'issueType': {'name': 'Backend-Task'},
                                           'status': {'name': '待办'}}}]}
        viewed = {'subtasks': [
            {'key': 'AIP-124', 'fields': {'summary': 'Backend', 'issuetype': {'name': 'Backend-Task'},
                                           'status': {'name': '待办'}}}]}
        expected = [{'key': 'AIP-124', 'summary': 'Backend', 'status': '待办',
                     'type': 'Backend-Task'}]
        self.assertEqual(monitor.issue_subtasks(listed), expected)
        self.assertEqual(monitor.issue_subtasks(viewed), expected)
        self.assertEqual(monitor.issue_subtasks({}), [])
        self.assertEqual(monitor.issue_subtasks({'Subtasks': [{'fields': {}}]}), [])

    def test_issue_assignee_accepts_list_and_view_payloads(self):
        self.assertEqual(
            monitor.issue_assignee({'assignee': {'displayName': 'ChenAnkang 陈安康'}}),
            (None, 'ChenAnkang 陈安康'))
        self.assertEqual(
            monitor.issue_assignee({'assignee': {'name': 'ankang.chen',
                                                 'displayName': 'ChenAnkang 陈安康'}}),
            ('ankang.chen', 'ChenAnkang 陈安康'))
        self.assertEqual(monitor.issue_assignee({}), (None, ''))

    def test_reviewer_resolution_accepts_login_variants(self):
        state = {'jobs': {}}
        config = dict(self.config, gitlabTokenFile='/tmp/gitlab-token')
        with patch.object(monitor, 'gitlab_users') as users:
            users.side_effect = lambda config, params: (
                [{'id': 969, 'username': 'yangting'}] if params == {'username': 'yangting'} else [])
            reviewer, error = monitor.resolve_reviewer(
                config, state, 'ting.yang', 'YangTing 杨婷')
        self.assertEqual(reviewer, {'id': 969, 'username': 'yangting'})
        self.assertEqual(error, '')
        # The hit is cached, so a later dispatch costs no API call.
        self.assertEqual(state['gitlabUsers']['ting.yang']['username'], 'yangting')

    def test_reviewer_resolution_reports_unresolved_assignee(self):
        state = {'jobs': {}}
        config = dict(self.config, gitlabTokenFile='/tmp/gitlab-token')
        with patch.object(monitor, 'gitlab_users', return_value=[]):
            reviewer, error = monitor.resolve_reviewer(config, state, 'kai.wang', 'WangKai 王凯')
        self.assertIsNone(reviewer)
        self.assertEqual(error, '')

    def test_reviewer_overrides_manual_mapping_wins(self):
        state = {'jobs': {}}
        config = dict(self.config, gitlabTokenFile='/tmp/gitlab-token',
                      reviewerOverrides={'kai.wang': 'kaikai'})
        with patch.object(monitor, 'gitlab_users',
                          return_value=[{'id': 42, 'username': 'kaikai'}]) as users:
            reviewer, error = monitor.resolve_reviewer(config, state, 'kai.wang', 'WangKai 王凯')
        self.assertEqual(reviewer, {'id': 42, 'username': 'kaikai'})
        self.assertEqual(error, '')
        users.assert_called_once_with(config, {'username': 'kaikai'})

    def test_reviewer_override_without_gitlab_user_is_reported(self):
        state = {'jobs': {}}
        config = dict(self.config, gitlabTokenFile='/tmp/gitlab-token',
                      reviewerOverrides={'kai.wang': 'nobody'})
        with patch.object(monitor, 'gitlab_users', return_value=[]):
            reviewer, error = monitor.resolve_reviewer(config, state, 'kai.wang', 'WangKai 王凯')
        self.assertIsNone(reviewer)
        self.assertIn('not a GitLab user', error)

    def test_subtask_issue_prompt_forbids_decomposition_and_mr_assignment(self):
        story = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Story', 'subtask': False},
            Subtasks=[{'key': 'AIP-124', 'fields': {'summary': 'Backend', 'issueType': {'name': 'Backend-Task'},
                                                    'status': {'name': '待办'}}},
                      {'key': 'AIP-125', 'fields': {'summary': 'Frontend', 'issueType': {'name': 'Frontend-Task'},
                                                    'status': {'name': '待办'}}}]))
        config = dict(self.config, apiKeyFile='/tmp/api-key', automakerUrl='http://127.0.0.1:3008')
        prompt = monitor.task_description(
            story, config, '/tmp/wt', 'jira/aip-123-kaka',
            reviewer={'id': 1930, 'username': 'ankang.chen'},
            reviewer_display='ChenAnkang 陈安康')
        self.assertIn('already split into Jira subtasks', prompt)
        self.assertNotIn('Autonomous decomposition', prompt)
        self.assertNotIn('features/create', prompt)
        self.assertIn('AIP-124', prompt)
        self.assertIn('AIP-125', prompt)
        self.assertNotIn('reviewer_ids', prompt)
        self.assertIn('review and merge are handled separately', prompt)

    def test_epic_prompt_without_subtasks_asks_for_manual_decomposition(self):
        epic = dict(self.issue, fields=dict(
            self.issue['fields'], issueType={'name': 'Epic', 'subtask': False}, Subtasks=[]))
        config = dict(self.config, apiKeyFile='/tmp/api-key', automakerUrl='http://127.0.0.1:3008')
        prompt = monitor.task_description(
            epic, config, '/tmp/wt', 'jira/aip-123-dodo',
            reviewer={'id': 969, 'username': 'yangting'}, reviewer_display='YangTing 杨婷')
        self.assertNotIn('Autonomous decomposition', prompt)
        self.assertIn('Manual decomposition only', prompt)
        self.assertIn('"outcome": "needs_input"', prompt)
        self.assertNotIn('already split into Jira subtasks', prompt)

    def test_subtask_reconcile_plan_collapses_unstarted_children(self):
        detail = {'key': 'AIP-123', 'fields': dict(
            self.issue['fields'], issueType={'name': 'Story', 'subtask': False},
            assignee={'name': 'ankang.chen', 'displayName': 'ChenAnkang 陈安康'},
            Subtasks=[{'key': 'AIP-124', 'fields': {'summary': 'Backend',
                                                    'issueType': {'name': 'Backend-Task'},
                                                    'status': {'name': '待办'}}}] )}
        state = {'jobs': {'AIP-123': {'featureId': 'jira-dodo-aip-123', 'branch': 'jira/aip-123-dodo',
                                      'worktree': '/tmp/wt'}}}
        features = [
            {'id': 'jira-dodo-aip-123', 'status': 'waiting_approval', 'branchName': 'jira/aip-123-dodo'},
            {'id': 'aip-123-child-1', 'status': 'backlog', 'branchName': 'jira/aip-123-dodo'},
            {'id': 'aip-123-child-2', 'status': 'backlog', 'branchName': 'jira/aip-123-dodo'},
        ]
        api = Mock()
        api.call.return_value = {'features': features}
        config = dict(self.config, gitlabTokenFile='/tmp/gitlab-token', projectPath=str(self.root))
        with patch.object(monitor, 'issue_detail', return_value=detail), \
                patch.object(monitor, 'resolve_reviewer',
                             return_value=({'id': 1930, 'username': 'ankang.chen'}, '')):
            plan = monitor.subtask_reconcile_plan(config, state, api)
        self.assertEqual(len(plan['plan']), 1)
        entry = plan['plan'][0]
        self.assertEqual(entry['childrenRemoved'], ['aip-123-child-1', 'aip-123-child-2'])
        self.assertEqual(entry['childrenKept'], [])
        self.assertTrue(entry['restoreBacklog'])
        self.assertIn('already split into Jira subtasks', entry['description'])
        self.assertNotIn('reviewer_ids', entry['description'])

    def test_subtask_reconcile_keeps_started_children(self):
        detail = {'key': 'AIP-123', 'fields': dict(
            self.issue['fields'], issueType={'name': 'Story', 'subtask': False},
            Subtasks=[{'key': 'AIP-124', 'fields': {'summary': 'Backend',
                                                    'issueType': {'name': 'Backend-Task'},
                                                    'status': {'name': '待办'}}}] )}
        state = {'jobs': {'AIP-123': {'featureId': 'jira-dodo-aip-123', 'branch': 'jira/aip-123-dodo'}}}
        features = [
            {'id': 'jira-dodo-aip-123', 'status': 'waiting_approval', 'branchName': 'jira/aip-123-dodo'},
            {'id': 'aip-123-child-1', 'status': 'verified', 'branchName': 'jira/aip-123-dodo'},
            {'id': 'aip-123-child-2', 'status': 'backlog', 'branchName': 'jira/aip-123-dodo'},
        ]
        api = Mock()
        api.call.return_value = {'features': features}
        config = dict(self.config, projectPath=str(self.root),
                      apiKeyFile='/tmp/api-key', automakerUrl='http://127.0.0.1:3008')
        with patch.object(monitor, 'issue_detail', return_value=detail), \
                patch.object(monitor, 'resolve_reviewer', return_value=(None, '')):
            plan = monitor.subtask_reconcile_plan(config, state, api)
        entry = plan['plan'][0]
        self.assertEqual(entry['childrenRemoved'], ['aip-123-child-2'])
        self.assertEqual(entry['childrenKept'], ['aip-123-child-1'])
        self.assertTrue(entry['restoreBacklog'])

    def test_subtask_reconcile_apply_deletes_only_unstarted_children(self):
        api = Mock()
        api.call.return_value = {'success': True}
        config = dict(self.config, projectPath=str(self.root))
        state = {'jobs': {'AIP-123': {'featureId': 'jira-dodo-aip-123'}}}
        plan = {'plan': [{'key': 'AIP-123', 'featureId': 'jira-dodo-aip-123',
                          'childrenRemoved': ['aip-123-child-1'], 'childrenKept': [],
                          'restoreBacklog': True, 'subtasks': ['AIP-124'],
                          'reviewer': 'ankang.chen', 'description': 'new'}]}
        applied = monitor.apply_subtask_reconcile_plan(config, state, api, plan)
        routes = [call.args[0] for call in api.call.call_args_list]
        self.assertEqual(routes, ['features/delete', 'features/update'])
        self.assertEqual(api.call.call_args_list[0].args[1]['featureId'], 'aip-123-child-1')
        self.assertEqual(api.call.call_args_list[1].args[1]['updates'],
                         {'description': 'new', 'status': 'backlog', 'error': None})
        self.assertEqual(applied['removed'], ['aip-123-child-1'])
        self.assertEqual(applied['restored'], ['jira-dodo-aip-123'])
        self.assertEqual(state['jobs']['AIP-123']['jiraSubtasks'], ['AIP-124'])

    def test_branch_prefix_follows_the_jira_issue_type(self):
        cases = {
            'Epic': 'epic', 'epic': 'epic',
            'Story': 'story', 'Story-Task': 'story',
            'Improvement': 'impr', 'Impr-Task': 'impr',
            'Bug': 'bugfix', 'Defect': 'bugfix', 'Hotfix': 'bugfix',
            'Task': 'task', 'Backend-Task': 'task', 'Frontend-Task': 'task',
            'QA-Task': 'task', 'ALG-Task': 'task', 'API-Task': 'task',
            'Story-Task': 'story',
            '': 'feat', None: 'feat',
        }
        for issue_type_name, expected in cases.items():
            self.assertEqual(monitor.branch_prefix(issue_type_name), expected,
                             f'{issue_type_name!r} should map to {expected}')
        # Config overrides win, so a project can rename the prefixes freely.
        self.assertEqual(monitor.branch_prefix('Story', {'branchPrefixes': {'story': 'userstory'}}),
                         'userstory')

    def test_branch_name_uses_issue_type_prefix_and_key(self):
        story = dict(self.issue, key='AIP-114974',
                     fields=dict(self.issue['fields'], issueType={'name': 'Story', 'subtask': False}))
        epic = dict(self.issue, key='AIP-114878',
                    fields=dict(self.issue['fields'], issueType={'name': 'Epic', 'subtask': False}))
        backend = dict(self.issue, key='AIP-114939',
                       fields=dict(self.issue['fields'],
                                   issueType={'name': 'Backend-Task', 'subtask': True}))
        self.assertEqual(monitor.branch_name(story, 'AIP-114974'), 'story/aip-114974')
        self.assertEqual(monitor.branch_name(epic, 'AIP-114878'), 'epic/aip-114878')
        self.assertEqual(monitor.branch_name(backend, 'AIP-114939'), 'task/aip-114939')

    def test_branch_name_can_keep_the_dispatch_label(self):
        story = dict(self.issue, key='AIP-114927',
                     fields=dict(self.issue['fields'], issueType={'name': 'Story', 'subtask': False}))
        self.assertEqual(monitor.branch_name(story, 'AIP-114927'), 'story/aip-114927')
        self.assertEqual(
            monitor.branch_name(story, 'AIP-114927', {'branchIncludeLabel': True}, 'dodo'),
            'story/aip-114927-dodo')
        # A label without the flag is ignored, so the branch stays stable when a
        # task moves between kaka and dodo.
        self.assertEqual(monitor.branch_name(story, 'AIP-114927', {}, 'dodo'),
                         'story/aip-114927')

    def test_subtasks_covered_by_a_dispatched_parent_are_not_queued(self):
        story = dict(self.issue, key='AIP-123',
                     fields=dict(self.issue['fields'], issueType={'name': 'Story', 'subtask': False}))
        subtask = dict(self.issue, key='AIP-124',
                       fields=dict(self.issue['fields'],
                                   issueType={'name': 'Backend-Task', 'subtask': True}))
        orphan = dict(self.issue, key='AIP-125',
                      fields=dict(self.issue['fields'],
                                  issueType={'name': 'Frontend-Task', 'subtask': True}))
        with patch.object(monitor, 'covered_subtask_keys', return_value={'AIP-124'}) as covered:
            kept = monitor.drop_covered_subtasks(self.config, [story, subtask, orphan])
        self.assertEqual([issue['key'] for issue in kept], ['AIP-123', 'AIP-125'])
        covered.assert_called_once_with(self.config, {'AIP-123'})

    def test_subtask_lookup_failure_keeps_the_sweep(self):
        subtask = dict(self.issue, key='AIP-124',
                       fields=dict(self.issue['fields'],
                                   issueType={'name': 'Backend-Task', 'subtask': True}))
        parent = dict(self.issue, key='AIP-123')
        with patch.object(monitor, 'covered_subtask_keys', side_effect=RuntimeError('jira down')):
            kept = monitor.drop_covered_subtasks(self.config, [parent, subtask])
        self.assertEqual([issue['key'] for issue in kept], ['AIP-123', 'AIP-124'])

    def test_branch_rename_plan_only_touches_unstarted_unpushed_work(self):
        state = {'jobs': {
            'AIP-123': {'featureId': 'jira-kaka-aip-123', 'branch': 'jira/aip-123-kaka',
                        'worktree': str(self.root / '.worktrees/aip-123-kaka')},
            'AIP-124': {'featureId': 'jira-dodo-aip-124', 'branch': 'jira/aip-124-dodo',
                        'worktree': str(self.root / '.worktrees/aip-124-dodo')},
            'AIP-125': {'featureId': 'jira-dodo-aip-125', 'branch': 'jira/aip-125-dodo',
                        'worktree': str(self.root / '.worktrees/aip-125-dodo')},
        }}
        features = [
            {'id': 'jira-kaka-aip-123', 'status': 'backlog', 'branchName': 'jira/aip-123-kaka'},
            {'id': 'jira-dodo-aip-124', 'status': 'waiting_approval', 'branchName': 'jira/aip-124-dodo'},
            {'id': 'jira-dodo-aip-125', 'status': 'backlog', 'branchName': 'jira/aip-125-dodo'},
        ]
        detail = {'key': 'AIP-123',
                  'fields': {'issueType': {'name': 'Story', 'subtask': False}, 'Subtasks': []}}
        for key in ('AIP-124', 'AIP-125'):
            (self.root / f'.worktrees/{key.lower()}-dodo').mkdir(parents=True, exist_ok=True)
        (self.root / '.worktrees/aip-123-kaka').mkdir(parents=True, exist_ok=True)
        api = Mock()
        api.call.return_value = {'features': features}
        config = dict(self.config, projectPath=str(self.root),
                      apiKeyFile='/tmp/api-key', automakerUrl='http://127.0.0.1:3008')
        with patch.object(monitor, 'issue_detail', return_value=detail), \
                patch.object(monitor, 'worktree_is_clean', return_value=True), \
                patch.object(monitor, 'remote_branches', return_value={'jira/aip-125-dodo'}):
            plan = monitor.branch_rename_plan(config, state, api)
        self.assertEqual([entry['key'] for entry in plan['plan']], ['AIP-123'])
        entry = plan['plan'][0]
        self.assertEqual(entry['oldBranch'], 'jira/aip-123-kaka')
        self.assertEqual(entry['newBranch'], 'story/aip-123')
        self.assertTrue(entry['moveWorktree'])
        self.assertIn('story/aip-123', entry['description'])
        reasons = {item['key']: item['reason'] for item in plan['skipped']}
        self.assertIn('waiting_approval', reasons['AIP-124'])
        self.assertIn('pushed', reasons['AIP-125'])

    def test_branch_rename_apply_renames_then_moves_and_updates(self):
        state = {'jobs': {}}
        api = Mock()
        api.call.return_value = {'success': True}
        config = dict(self.config, projectPath=str(self.root))
        plan = {'plan': [{'key': 'AIP-123', 'featureId': 'jira-kaka-aip-123',
                          'oldBranch': 'jira/aip-123-kaka', 'newBranch': 'story/aip-123',
                          'oldWorktree': str(self.root / '.worktrees/aip-123-kaka'),
                          'newWorktree': str(self.root / '.worktrees/story-aip-123'),
                          'moveWorktree': True, 'description': 'new'}]}
        with patch.object(monitor, 'checked') as checked:
            applied = monitor.apply_branch_rename_plan(config, state, api, plan)
        self.assertEqual(checked.call_args_list[0].args[0],
                         ['git', '-C', str(self.root / '.worktrees/aip-123-kaka'),
                          'branch', '-m', 'story/aip-123'])
        self.assertEqual(checked.call_args_list[1].args[0],
                         ['git', '-C', str(self.root), 'worktree', 'move',
                          str(self.root / '.worktrees/aip-123-kaka'),
                          str(self.root / '.worktrees/story-aip-123')])
        self.assertEqual(api.call.call_args_list[0].args[1]['updates'],
                         {'branchName': 'story/aip-123', 'description': 'new'})
        self.assertEqual(state['jobs']['AIP-123']['branch'], 'story/aip-123')
        self.assertEqual(applied['renamed'], [{'old': 'jira/aip-123-kaka', 'new': 'story/aip-123'}])

    def test_started_branches_rename_only_without_pushed_work_or_mrs(self):
        started = self.root / '.worktrees/aip-123-dodo'
        started.mkdir(parents=True)
        receipt_dir = started / '.automaker/jira/jira-dodo-aip-123'
        receipt_dir.mkdir(parents=True)
        state = {'jobs': {'AIP-123': {'featureId': 'jira-dodo-aip-123',
                                      'branch': 'jira/aip-123-dodo',
                                      'worktree': str(started)}}}
        features = [{'id': 'jira-dodo-aip-123', 'status': 'waiting_approval',
                     'branchName': 'jira/aip-123-dodo'}]
        detail = {'key': 'AIP-123',
                  'fields': {'issueType': {'name': 'Story', 'subtask': False}, 'Subtasks': []}}
        api = Mock()
        api.call.return_value = {'features': features}
        config = dict(self.config, projectPath=str(self.root),
                      apiKeyFile='/tmp/api-key', automakerUrl='http://127.0.0.1:3008')

        def plan_with_receipt(receipt):
            (receipt_dir / 'jira-result.json').write_text(json.dumps(receipt))
            with patch.object(monitor, 'issue_detail', return_value=detail), \
                    patch.object(monitor, 'worktree_is_clean', return_value=True), \
                    patch.object(monitor, 'remote_branches', return_value=set()):
                return monitor.branch_rename_plan(config, state, api, include_started=True)

        blocked = plan_with_receipt({'issueKey': 'AIP-123', 'outcome': 'mr_created',
                                     'mergeRequests': ['https://gitblue.transwarp.io/a/b/-/merge_requests/1']})
        self.assertEqual(blocked['plan'], [])
        self.assertIn('MR', blocked['skipped'][0]['reason'])

        allowed = plan_with_receipt({'issueKey': 'AIP-123', 'outcome': 'needs_input'})
        self.assertEqual([entry['newBranch'] for entry in allowed['plan']], ['story/aip-123'])

        without_flag = monitor.branch_rename_plan(config, state, api)
        self.assertEqual(without_flag['plan'], [])

    def test_branch_rename_rolls_back_when_the_worktree_cannot_move(self):
        state = {'jobs': {}}
        api = Mock()
        config = dict(self.config, projectPath=str(self.root))
        plan = {'plan': [{'key': 'AIP-123', 'featureId': 'jira-kaka-aip-123',
                          'oldBranch': 'jira/aip-123-kaka', 'newBranch': 'story/aip-123',
                          'oldWorktree': str(self.root / '.worktrees/aip-123-kaka'),
                          'newWorktree': str(self.root / '.worktrees/story-aip-123'),
                          'moveWorktree': True, 'description': 'new'}]}

        def checked(args, **kwargs):
            if 'worktree' in args:
                raise RuntimeError('cannot move a working tree with submodules')
            return ''

        with patch.object(monitor, 'checked', side_effect=checked):
            applied = monitor.apply_branch_rename_plan(config, state, api, plan)
        self.assertEqual(applied['renamed'], [])
        self.assertEqual(applied['moved'], [])
        self.assertEqual(len(applied['errors']), 1)
        api.call.assert_not_called()
        self.assertNotIn('AIP-123', state['jobs'])

    def test_subtask_card_plan_only_collapses_never_started_work(self):
        state = {'jobs': {
            'AIP-123': {'featureId': 'jira-kaka-aip-123',
                        'jiraSubtasks': ['AIP-124', 'AIP-125', 'AIP-126']},
        }}
        features = [
            {'id': 'jira-kaka-aip-124', 'jiraKey': 'AIP-124', 'status': 'backlog',
             'branchName': 'feat/aip-124'},
            {'id': 'jira-kaka-aip-125', 'jiraKey': 'AIP-125', 'status': 'waiting_approval',
             'branchName': 'feat/aip-125'},
            {'id': 'jira-kaka-aip-126', 'jiraKey': 'AIP-126', 'status': 'backlog',
             'branchName': 'feat/aip-126'},
            {'id': 'jira-kaka-aip-123', 'jiraKey': 'AIP-123', 'status': 'backlog',
             'branchName': 'story/aip-123'},
        ]
        api = Mock()
        api.call.return_value = {'features': features}
        config = dict(self.config, projectPath=str(self.root))
        with patch.object(monitor, 'remote_branches', return_value={'feat/aip-126'}):
            plan = monitor.subtask_card_plan(config, state, api)
        self.assertEqual([entry['key'] for entry in plan['plan']], ['AIP-124'])
        self.assertEqual(plan['plan'][0]['parent'], 'AIP-123')
        reasons = {item['key']: item['reason'] for item in plan['skipped']}
        self.assertIn('already started', reasons['AIP-125'])
        self.assertIn('pushed', reasons['AIP-126'])
        # The parent card itself is never a collapse candidate.
        self.assertNotIn('AIP-123', reasons)

    def test_subtask_card_apply_deletes_and_marks_the_job(self):
        api = Mock()
        api.call.return_value = {'success': True}
        state = {'jobs': {'AIP-124': {'featureId': 'jira-kaka-aip-124', 'status': 'ready'}}}
        config = dict(self.config, projectPath=str(self.root))
        plan = {'plan': [{'key': 'AIP-124', 'parent': 'AIP-123',
                          'featureId': 'jira-kaka-aip-124'}]}
        applied = monitor.apply_subtask_card_plan(config, state, api, plan)
        self.assertEqual(applied['removed'], ['jira-kaka-aip-124'])
        self.assertEqual(api.call.call_args.args[0], 'features/delete')
        self.assertEqual(state['jobs']['AIP-124']['status'], 'collapsed_into_parent')
        self.assertEqual(state['jobs']['AIP-124']['collapsedInto'], 'AIP-123')

    def test_agent_split_keys_detects_agent_decomposition(self):
        features = [
            {'id': 'aip-114866-child-1'},
            {'id': 'aip-114866-child-10'},
            {'id': 'jira-dodo-aip-114866', 'jiraKey': 'AIP-114866'},
            {'id': 'jira-kaka-aip-114915', 'jiraKey': 'AIP-114915'},
        ]
        self.assertEqual(monitor.agent_split_keys(features), {'AIP-114866'})
        self.assertEqual(monitor.agent_split_keys([]), set())

    def test_import_keeps_the_agents_split_for_decomposed_epics(self):
        epic = {'key': 'AIP-114866', 'fields': {'issuetype': {'name': 'Epic'},
                                                'summary': 'Epic', 'labels': ['dodo']}}
        story = {'key': 'AIP-114915', 'fields': {'summary': 'Story', 'labels': ['kaka']}}
        existing = [{'id': 'aip-114866-child-1', 'jiraKey': 'AIP-114866'}]
        config = dict(self.config, projectPath=str(self.root), keepAgentSplit=True)
        with patch.object(monitor, 'issue_detail', return_value=epic), \
                patch.object(monitor, 'search_jql', return_value=[story]):
            plan = monitor.import_tree_plan(config, 'AIP-114866', existing_features=existing)
        self.assertEqual(plan['cards'], [])
        self.assertTrue(any('already decomposed by the agent' in note for note in plan['notes']))

    def test_import_uses_the_jira_story_split_by_default(self):
        epic = {'key': 'AIP-114866', 'fields': {'issuetype': {'name': 'Epic'},
                                                'summary': 'Epic', 'labels': ['dodo']}}
        story = {'key': 'AIP-114915', 'fields': {'issuetype': {'name': 'Story'},
                                                 'summary': 'Story', 'labels': ['kaka'],
                                                 'subtasks': []}}
        existing = [{'id': 'aip-114866-child-1', 'jiraKey': 'AIP-114866'}]
        config = dict(self.config, projectPath=str(self.root))
        with patch.object(monitor, 'issue_detail', return_value=epic), \
                patch.object(monitor, 'search_jql', return_value=[story]):
            plan = monitor.import_tree_plan(config, 'AIP-114866', existing_features=existing)
        # The legacy child cards do not stop the story import.
        self.assertEqual(plan['executionUnit'], 'story')

    def test_import_reuses_the_existing_card_label(self):
        story = {'key': 'AIP-9', 'fields': {
            'issuetype': {'name': 'Story', 'subtask': False}, 'summary': 'Story',
            'labels': ['kaka'],
            'subtasks': [{'key': 'AIP-10', 'fields': {
                'summary': 'BE work', 'issuetype': {'name': 'Backend-Task'},
                'status': {'name': '待办'}}}]}}
        epic = {'key': 'AIP-1', 'fields': {'issuetype': {'name': 'Epic'}, 'summary': 'Epic',
                                           'labels': ['dodo'], 'subtasks': []}}
        existing = [{'id': 'jira-kaka-aip-9', 'jiraKey': 'AIP-9'}]
        config = dict(self.config, projectPath=str(self.root))

        def lookup(config, key):
            return {'AIP-1': epic, 'AIP-9': story, 'AIP-10': story}.get(str(key).upper())

        with patch.object(monitor, 'issue_detail', side_effect=lookup):
            plan = monitor.import_tree_plan(config, 'AIP-9', existing_features=existing)

        self.assertEqual([card['id'] for card in plan['cards']], ['jira-kaka-aip-9'])
        self.assertEqual(plan['cards'][0]['jiraSubtasks'][0]['key'], 'AIP-10')

    def test_collapsed_worktree_plan_skips_pushed_and_dirty_checkouts(self):
        clean = self.root / '.worktrees/feat-aip-124'
        dirty = self.root / '.worktrees/feat-aip-125'
        pushed = self.root / '.worktrees/feat-aip-126'
        for path in (clean, dirty, pushed):
            path.mkdir(parents=True)
        state = {'jobs': {
            'AIP-124': {'status': 'collapsed_into_parent', 'worktree': str(clean),
                        'branch': 'feat/aip-124'},
            'AIP-125': {'status': 'collapsed_into_parent', 'worktree': str(dirty),
                        'branch': 'feat/aip-125'},
            'AIP-126': {'status': 'collapsed_into_parent', 'worktree': str(pushed),
                        'branch': 'feat/aip-126'},
            'AIP-127': {'status': 'running', 'worktree': str(self.root / '.worktrees/x'),
                        'branch': 'feat/aip-127'},
        }}
        config = dict(self.config, projectPath=str(self.root))
        with patch.object(monitor, 'remote_branches', return_value={'feat/aip-126'}), \
                patch.object(monitor, 'worktree_is_clean',
                             side_effect=lambda path: path != str(dirty)):
            plan = monitor.collapsed_worktree_plan(config, state)
        self.assertEqual([entry['key'] for entry in plan['plan']], ['AIP-124'])
        reasons = {item['key']: item['reason'] for item in plan['skipped']}
        self.assertIn('local changes', reasons['AIP-125'])
        self.assertIn('pushed', reasons['AIP-126'])

    def test_collapsed_worktree_apply_removes_checkout_and_branch(self):
        state = {'jobs': {'AIP-124': {'status': 'collapsed_into_parent'}}}
        config = dict(self.config, projectPath=str(self.root))
        plan = {'plan': [{'key': 'AIP-124', 'worktree': str(self.root / '.worktrees/feat-aip-124'),
                          'branch': 'feat/aip-124'}]}
        with patch.object(monitor, 'checked') as checked, \
                patch.object(monitor, 'command') as command:
            command.return_value = subprocess.CompletedProcess([], 0, '', '')
            applied = monitor.apply_collapsed_worktree_plan(config, state, Mock(), plan)
        self.assertEqual(checked.call_args.args[0],
                         ['git', '-C', str(self.root), 'worktree', 'remove', '--force',
                          str(self.root / '.worktrees/feat-aip-124')])
        self.assertEqual(command.call_args.args[0],
                         ['git', '-C', str(self.root), 'branch', '-D', 'feat/aip-124'])
        self.assertEqual(applied['worktreesRemoved'],
                         [str(self.root / '.worktrees/feat-aip-124')])
        self.assertEqual(applied['branchesDeleted'], ['feat/aip-124'])

    def test_jira_type_plan_maps_issue_type_to_work_type(self):
        state = {'jobs': {
            'AIP-123': {'featureId': 'jira-kaka-aip-123'},
            'AIP-124': {'featureId': 'jira-kaka-aip-124'},
            'AIP-125': {'featureId': 'jira-kaka-aip-125'},
        }}
        features = [
            {'id': 'jira-kaka-aip-123', 'jiraKey': 'AIP-123', 'jiraType': 'story'},
            {'id': 'jira-kaka-aip-124', 'jiraKey': 'AIP-124', 'jiraType': 'feat'},
            {'id': 'jira-kaka-aip-125', 'jiraKey': 'AIP-125'},
            # Child features of a decomposed Epic share the parent key and must
            # receive the same work type.
            {'id': 'aip-123-child-1', 'jiraKey': 'AIP-123'},
        ]
        details = {
            'AIP-123': {'key': 'AIP-123', 'fields': {'issueType': {'name': 'Story'}}},
            'AIP-124': {'key': 'AIP-124', 'fields': {'issueType': {'name': 'Backend-Task'}}},
            'AIP-125': {'key': 'AIP-125', 'fields': {'issueType': {'name': 'Improvement'}}},
        }
        api = Mock()
        api.call.return_value = {'features': features}
        config = dict(self.config, projectPath=str(self.root))
        with patch.object(monitor, 'issue_detail', side_effect=lambda config, key: details[key]):
            plan = monitor.jira_type_plan(config, state, api)
        # AIP-123 is already correct and stays untouched; the task type corrects
        # `feat` to `task`; the missing field is filled in.
        self.assertEqual({(e['featureId'], e['jiraType']) for e in plan['plan']},
                         {('jira-kaka-aip-124', 'task'), ('jira-kaka-aip-125', 'impr'),
                          ('aip-123-child-1', 'story')})

        api.call.reset_mock()
        api.call.return_value = {'success': True}
        applied = monitor.apply_jira_type_plan(config, state, api, plan)
        self.assertEqual(applied['updated'],
                         ['jira-kaka-aip-124', 'jira-kaka-aip-125', 'aip-123-child-1'])
        self.assertEqual(api.call.call_args_list[0].args[1]['updates'], {'jiraType': 'task'})
        self.assertEqual(state['jobs']['AIP-125']['jiraType'], 'impr')

    def test_description_refresh_rebuilds_prompt_and_keeps_context(self):
        old = ('## Jira context (imported from https://jira.example)\n\n'
               'Story AIP-9: summary\n\n'
               'Implement Jira AIP-123: https://jira.example/browse/AIP-123.\n\n'
               'The user authorized monitoring AIP issues with label dodo.\n'
               'Workflow:\n1. old\n')
        state = {'jobs': {'AIP-123': {'worktree': '/wt/aip-123-kaka'}}}
        features = [
            {'id': 'jira-kaka-aip-123', 'jiraKey': 'AIP-123', 'jiraImported': True,
             'branchName': 'jira/aip-123-kaka', 'description': old},
            # Legacy automatic-decomposition cards keep their own scope.
            {'id': 'aip-123-child-1', 'jiraKey': 'AIP-123', 'description': old},
        ]
        detail = {'key': 'AIP-123', 'fields': {
            'summary': 'Example', 'description': 'Do it',
            'issueType': {'name': 'Task', 'subtask': False},
            'attachment': [{'filename': 'huge-attachment.bin', 'size': 10 ** 9}]}}
        payload = {'key': 'AIP-123', 'fields': {
            'summary': 'Example', 'description': 'Do it',
            'issueType': {'name': 'Task', 'subtask': False},
            'components': [{'name': 'kb-agent'}], 'attachment': None, 'issuelinks': None}}
        api = Mock()
        api.call.return_value = {'features': features}
        config = dict(self.config, projectPath=str(self.root))
        with patch.object(monitor, 'issue_detail', return_value=detail), \
                patch.object(monitor, 'issue_list_payload', return_value=payload), \
                patch.object(monitor, 'reviewer_for_assignee',
                             return_value=(None, '', '', '')), \
                patch.object(monitor, 'worktree_by_branch', return_value={}):
            plan = monitor.description_refresh_plan(config, state, api)
        self.assertEqual([entry['featureId'] for entry in plan['plan']],
                         ['jira-kaka-aip-123'])
        refreshed = plan['plan'][0]['description']
        # The imported Jira context survives; the monitor prompt is rebuilt with
        # the current rules, the card branch and the card worktree.
        self.assertTrue(refreshed.startswith('## Jira context (imported'))
        self.assertIn('Repository: ', refreshed)
        self.assertIn('Requirements:', refreshed)
        self.assertIn('Delivery:', refreshed)
        self.assertIn('jira/aip-123-kaka', refreshed)
        self.assertIn('/wt/aip-123-kaka', refreshed)
        self.assertNotIn('authorized monitoring', refreshed)
        # The snapshot uses the compact list payload, not the full issue view.
        self.assertIn('"attachment": null', refreshed)
        self.assertNotIn('huge-attachment.bin', refreshed)
        self.assertEqual([entry['featureId'] for entry in plan['skipped']],
                         ['aip-123-child-1'])

        api.call.reset_mock()
        api.call.return_value = {'success': True}
        applied = monitor.apply_description_refresh(config, state, api, plan)
        self.assertEqual(applied['updated'], ['jira-kaka-aip-123'])
        self.assertEqual(api.call.call_args.args[0], 'features/update')
        self.assertNotIn('description', monitor.plan_without_payloads(plan)['plan'][0])


class JiraHierarchyImportTests(unittest.TestCase):
    """Epic -> Story -> Task import: product owns the split, tasks execute."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = {'jiraProject': 'AIP', 'projectPath': str(self.root),
                       'jiraUrl': 'https://jira.example', 'jiraCommand': 'jira',
                       'jiraLabels': {'autoStart': ['dodo'], 'manualStart': ['kaka']},
                       'branchIncludeLabel': True,
                       'model': 'pi:litellm/worker', 'reasoningEffort': 'medium',
                       'targetBranch': 'dev', 'gitlabHost': 'gitlab.example'}
        self.issues = {}

    def issue(self, key, type_name, summary='Summary', description='', *, subtask=False,
              parent=None, labels=('dodo',), epic_link=None, subtasks=(), links=()):
        """Minimal raw Jira issue payload for the importer."""
        fields = {'summary': summary, 'description': description, 'labels': list(labels),
                  'issuetype': {'name': type_name, 'subtask': subtask},
                  'status': {'name': '待办'}, 'parent': {'key': parent} if parent else None,
                  'issuelinks': list(links), 'subtasks': []}
        if epic_link:
            fields['customfield_10007'] = epic_link
        for sub in subtasks:
            fields['subtasks'].append({
                'key': sub['key'],
                'fields': {'summary': sub.get('summary', ''),
                           'status': {'name': '待办'},
                           'issuetype': {'name': sub.get('type', 'Task')}}})
        issue = {'key': key, 'fields': fields}
        self.issues[key] = issue
        return issue

    def plan(self, root_key, stories=(), existing=None):
        """Run import_tree_plan against the fake Jira."""
        def lookup(config, key):
            return self.issues.get(str(key).upper())

        with patch.object(monitor, 'issue_detail', side_effect=lookup), \
                patch.object(monitor, 'search_jql', return_value=list(stories)), \
                patch.object(monitor, 'worktree_path_for_branch',
                             side_effect=lambda config, branch, default: default):
            return monitor.import_tree_plan(self.config, root_key, existing_features=existing)

    def test_epic_link_field_reads_the_classic_link(self):
        self.assertEqual(monitor.epic_link_key({'customfield_10007': 'AIP-7'}), 'AIP-7')
        self.assertEqual(monitor.epic_link_key({'customfield_10007': {'key': 'AIP-7'}}), 'AIP-7')
        self.assertIsNone(monitor.epic_link_key({'customfield_10007': None}))
        self.assertIsNone(monitor.epic_link_key({'customfield_10007': 'not-a-key'}))
        self.assertEqual(
            monitor.epic_link_key({'customfield_99': 'AIP-7'}, {'epicLinkField': 'customfield_99'}),
            'AIP-7')

    def test_blocks_links_become_blocked_by_keys(self):
        blocked = {'fields': {'issuelinks': [
            {'type': {'name': 'Blocks', 'inward': 'is blocked by'},
             'inwardIssue': {'key': 'AIP-9'}},
            # outward means this issue blocks the other one, not the reverse
            {'type': {'name': 'Blocks', 'outward': 'blocks'},
             'outwardIssue': {'key': 'AIP-10'}},
            {'type': {'name': 'Relates'}, 'inwardIssue': {'key': 'AIP-11'}},
        ]}}
        self.assertEqual(monitor.blocked_by_keys(blocked), ['AIP-9'])

    def test_context_version_tracks_ancestor_content(self):
        epic = self.issue('AIP-1', 'Epic', 'Epic summary', 'epic body', labels=[])
        story = self.issue('AIP-2', 'Story', 'Story summary', 'story body', epic_link='AIP-1')
        task = self.issue('AIP-3', 'Backend-Task', 'Task summary', 'task body',
                          subtask=True, parent='AIP-2')
        chain = {'epic': epic, 'story': story, 'task': task}
        version = monitor.lineage_version(chain)
        self.assertRegex(version, r'^[0-9a-f]{12}$')

        story['fields']['description'] = 'story body changed'
        self.assertNotEqual(monitor.lineage_version(chain), version)

    def test_parent_prompt_can_authorize_decomposition(self):
        epic = self.issue('AIP-1', 'Epic', labels=[])
        refused = monitor.task_description(epic, self.config, '/tmp/wt', 'epic/AIP-1-dodo')
        allowed = monitor.task_description(epic, self.config, '/tmp/wt', 'epic/AIP-1-dodo',
                                           allow_decomposition=True)
        self.assertIn('Manual decomposition only', refused)
        self.assertNotIn('Manual decomposition only', allowed)
        self.assertIn('explicitly authorized', allowed)

    def test_story_import_creates_one_card_per_story_with_lineage(self):
        story = self.issue('AIP-9', 'Story', 'Story summary', 'story body',
                           epic_link='AIP-1', subtasks=[
                               {'key': 'AIP-10', 'type': 'Backend-Task'},
                               {'key': 'AIP-11', 'type': 'QA-Task'}])
        self.issue('AIP-1', 'Epic', 'Epic summary', 'epic body', labels=[])
        self.issue('AIP-10', 'Backend-Task', 'BE work', 'be body', subtask=True, parent='AIP-9')
        self.issue('AIP-11', 'QA-Task', 'QA work', 'qa body', subtask=True, parent='AIP-9')

        plan = self.plan('AIP-9')

        # One story = one card; its Jira subtasks are scope inside that card.
        self.assertEqual([card['id'] for card in plan['cards']], ['jira-dodo-aip-9'])
        card = plan['cards'][0]
        self.assertEqual(plan['executionUnit'], 'story')
        self.assertEqual(card['mode'], 'execute')
        self.assertEqual(card['parentJiraKey'], 'AIP-1')
        self.assertEqual(card['epicJiraKey'], 'AIP-1')
        self.assertEqual(card['issueType'], 'Story')
        self.assertEqual(card['planningMode'], 'skip')
        self.assertEqual(card['dependencies'], [])
        self.assertEqual(plan['worktreeScope'], 'story')
        self.assertEqual(plan['branch'], 'story/aip-9-dodo')
        # The prompt carries the lineage; the full bundle goes to the worktree
        self.assertIn('AIP-1: Epic summary', card['description'])
        self.assertIn('AIP-9: Story summary', card['description'])
        self.assertIn(card['jiraContext']['path'], card['description'])
        self.assertIn('## Story AIP-9', card['contextMarkdown'])
        self.assertIn('## Epic AIP-1', card['contextMarkdown'])

    def test_task_execution_unit_imports_one_card_per_subtask(self):
        story = self.issue('AIP-9', 'Story', 'Story summary', 'story body',
                           epic_link='AIP-1', subtasks=[
                               {'key': 'AIP-10', 'type': 'Backend-Task'},
                               {'key': 'AIP-11', 'type': 'QA-Task'}])
        self.issue('AIP-1', 'Epic', 'Epic summary', 'epic body', labels=[])
        self.issue('AIP-10', 'Backend-Task', 'BE work', 'be body', subtask=True, parent='AIP-9')
        self.issue('AIP-11', 'QA-Task', 'QA work', 'qa body', subtask=True, parent='AIP-9')
        self.config['executionUnit'] = 'task'

        plan = self.plan('AIP-9')

        self.assertEqual([card['id'] for card in plan['cards']],
                         ['jira-dodo-aip-10', 'jira-dodo-aip-11'])
        first, second = plan['cards']
        self.assertEqual(plan['executionUnit'], 'task')
        self.assertEqual(first['parentJiraKey'], 'AIP-9')
        self.assertEqual(second['dependencies'], ['jira-dodo-aip-10'])

    def test_epic_import_allows_decomposition_for_story_without_subtasks(self):
        epic = self.issue('AIP-1', 'Epic', labels=[])
        story = self.issue('AIP-2', 'Story', 'Unsplit story', epic_link='AIP-1')

        plan = self.plan('AIP-1', stories=[story])

        self.assertEqual(len(plan['cards']), 1)
        card = plan['cards'][0]
        self.assertEqual(card['id'], 'jira-dodo-aip-2')
        self.assertEqual(card['mode'], 'decompose')
        self.assertEqual(card['planningMode'], 'full')
        self.assertIn('explicitly authorized', card['description'])
        self.assertNotIn('Manual decomposition only', card['description'])
        self.assertEqual(card['epicJiraKey'], 'AIP-1')
        self.assertEqual(epic['key'], plan['root'])

    def test_epic_without_stories_imports_as_a_decompose_card(self):
        self.issue('AIP-1', 'Epic', 'Unsplit epic', 'epic body')

        plan = self.plan('AIP-1', stories=[])

        self.assertEqual(len(plan['cards']), 1)
        card = plan['cards'][0]
        self.assertEqual(card['id'], 'jira-dodo-aip-1')
        self.assertEqual(card['mode'], 'decompose')
        self.assertEqual(card['planningMode'], 'full')
        self.assertEqual(card['issueType'], 'Epic')
        self.assertEqual(card['epicJiraKey'], 'AIP-1')
        self.assertIsNone(card['parentJiraKey'])
        self.assertIn('explicitly authorized', card['description'])

    def test_blocking_story_becomes_a_dependency_of_every_sibling_task(self):
        blocker_story = self.issue(
            'AIP-3', 'Story', 'Blocker story', epic_link='AIP-1', labels=[],
            subtasks=[{'key': 'AIP-30', 'type': 'Backend-Task'}])
        self.issue('AIP-30', 'Backend-Task', 'blocker work', subtask=True, parent='AIP-3')
        blocked_story = self.issue(
            'AIP-2', 'Story', 'Blocked story', epic_link='AIP-1',
            subtasks=[{'key': 'AIP-20', 'type': 'Backend-Task'},
                      {'key': 'AIP-21', 'type': 'QA-Task'}],
            links=[{'type': {'name': 'Blocks', 'inward': 'is blocked by'},
                    'inwardIssue': {'key': 'AIP-3'}},
                   {'type': {'name': 'Blocks', 'inward': 'is blocked by'},
                    'inwardIssue': {'key': 'AIP-99'}}])
        self.issue('AIP-20', 'Backend-Task', 'blocked work', subtask=True, parent='AIP-2')
        self.issue('AIP-21', 'QA-Task', 'blocked qa', subtask=True, parent='AIP-2')
        self.issue('AIP-1', 'Epic', 'Epic summary', labels=[])

        plan = self.plan('AIP-1', stories=[blocker_story, blocked_story])
        by_id = {card['id']: card for card in plan['cards']}

        # Story units: the blocked story depends on the blocking story.
        self.assertEqual(sorted(by_id), ['jira-dodo-aip-2', 'jira-dodo-aip-3'])
        self.assertEqual(by_id['jira-dodo-aip-2']['dependencies'], ['jira-dodo-aip-3'])
        self.assertEqual(by_id['jira-dodo-aip-3']['dependencies'], [])
        # Every story stays on its own branch by default
        self.assertEqual(by_id['jira-dodo-aip-2']['branchName'], 'story/aip-2-dodo')
        self.assertEqual(by_id['jira-dodo-aip-3']['branchName'], 'story/aip-3-dodo')
        self.assertTrue(any('AIP-99' in note for note in plan['notes']))

    def test_epic_scope_shares_one_worktree(self):
        story = self.issue('AIP-2', 'Story', 'Story', epic_link='AIP-1',
                           subtasks=[{'key': 'AIP-20', 'type': 'Backend-Task'}])
        self.issue('AIP-20', 'Backend-Task', 'work', subtask=True, parent='AIP-2')
        self.issue('AIP-1', 'Epic', 'Epic summary', labels=[])

        with patch.object(monitor, 'worktree_path_for_branch',
                          side_effect=lambda config, branch, default: default):
            plan = self.plan('AIP-1', stories=[story])

        self.assertEqual(plan['worktreeScope'], 'story')
        scoped = dict(self.config, worktreeScope='epic')

        def lookup(config, key):
            return self.issues.get(str(key).upper())

        with patch.object(monitor, 'issue_detail', side_effect=lookup), \
                patch.object(monitor, 'search_jql', return_value=[story]), \
                patch.object(monitor, 'worktree_path_for_branch',
                             side_effect=lambda config, branch, default: default):
            epic_plan = monitor.import_tree_plan(scoped, 'AIP-1')

        self.assertEqual(epic_plan['worktreeScope'], 'epic')
        self.assertEqual(epic_plan['cards'][0]['branchName'], 'epic/aip-1-dodo')

    def test_apply_creates_cards_and_writes_context_files(self):
        self.issue('AIP-9', 'Story', 'Story summary', epic_link='AIP-1',
                   subtasks=[{'key': 'AIP-10', 'type': 'Backend-Task'}])
        self.issue('AIP-1', 'Epic', 'Epic summary', labels=[])
        self.issue('AIP-10', 'Backend-Task', 'BE work', subtask=True, parent='AIP-9')
        plan = self.plan('AIP-9')

        calls = []
        api = Mock()
        api.call.side_effect = lambda route, body=None: (
            calls.append((route, body)) or {'features': []})

        with patch.object(monitor, 'ensure_worktree_for_branch',
                          return_value='reused'):
            result = monitor.apply_import_tree(self.config, plan, api)

        create = [body for route, body in calls if route == 'features/create']
        self.assertEqual(len(create), 1)
        feature = create[0]['feature']
        self.assertEqual(feature['id'], 'jira-dodo-aip-9')
        self.assertTrue(feature['jiraImported'])
        self.assertEqual(feature['parentJiraKey'], 'AIP-1')
        self.assertEqual(feature['jiraContext']['path'],
                         plan['cards'][0]['jiraContext']['path'])
        # Plan-only fields never reach the feature payload
        self.assertNotIn('contextMarkdown', feature)
        self.assertNotIn('mode', feature)
        context_file = Path(plan['worktree']) / feature['jiraContext']['path']
        self.assertTrue(context_file.exists())
        self.assertIn('## Epic AIP-1', context_file.read_text(encoding='utf-8'))
        self.assertEqual(result['created'], ['jira-dodo-aip-9'])


class JiraChangeDetectionTests(unittest.TestCase):
    """Re-import: new subtasks are absorbed, edit/removal is reported only."""

    def test_added_subtask_is_absorbed_without_a_change_entry(self):
        existing = {'jiraSubtasks': [{'key': 'AIP-1', 'summary': 'one'}]}
        card = {'jiraSubtasks': [{'key': 'AIP-1', 'summary': 'one'},
                                 {'key': 'AIP-2', 'summary': 'two'}]}
        changes = monitor.jira_change_summary(card, existing)
        # The added subtask grows the scope silently; it is not a "change" to review.
        self.assertFalse([c for c in changes if 'AIP-2' in str(c.get('after'))])

    def test_changed_subtask_summary_is_reported_before_after(self):
        existing = {'jiraSubtasks': [{'key': 'AIP-1', 'summary': 'one old'}]}
        card = {'jiraSubtasks': [{'key': 'AIP-1', 'summary': 'one new'}]}
        changes = monitor.jira_change_summary(card, existing)
        entry = next(c for c in changes if c['field'] == 'subtasks')
        self.assertIn('one old', entry['before'])
        self.assertIn('one new', entry['after'])
        self.assertIn('detectedAt', entry)

    def test_removed_subtask_is_reported_with_before_only(self):
        existing = {'jiraSubtasks': [{'key': 'AIP-1', 'summary': 'one'}]}
        card = {'jiraSubtasks': []}
        changes = monitor.jira_change_summary(card, existing)
        entry = next(c for c in changes if c['field'] == 'subtasks')
        self.assertIn('removed', entry['before'])
        self.assertNotIn('after', entry)

    def test_requirement_edit_is_reported_by_context_version(self):
        existing = {'jiraSubtasks': [], 'jiraContext': {'version': 'aaaa'},
                    'title': 'Same title'}
        card = {'jiraSubtasks': [], 'jiraContext': {'version': 'bbbb'},
                'summary': 'Same title'}
        changes = monitor.jira_change_summary(card, existing)
        entry = next(c for c in changes if c['field'] == 'requirements')
        self.assertEqual(entry['before'], 'aaaa')
        self.assertEqual(entry['after'], 'bbbb')

    def test_unchanged_card_produces_no_changes(self):
        same = {'jiraSubtasks': [{'key': 'AIP-1', 'summary': 'one'}],
                'jiraContext': {'version': 'aaaa'}, 'title': 'T', 'summary': 'T',
                'labels': ['dodo'], 'assignee': 'ankang.chen'}
        self.assertEqual(monitor.jira_change_summary(same, same), [])

    def test_apply_keeps_previous_changes_and_records_new_ones(self):
        plan = {'branch': 'story/aip-1-dodo', 'worktree': '/tmp/wt', 'cards': [{
            'id': 'jira-dodo-aip-1', 'mode': 'execute', 'title': 'AIP-1: T',
            'description': 'd', 'jiraKey': 'AIP-1', 'jiraSubtasks': [],
            'jiraContext': {'version': 'bbbb', 'syncedAt': 'now', 'path': 'ctx.md'},
            'worktree': '/tmp/wt', 'contextMarkdown': 'ctx'}]}
        api = Mock()
        api.call.side_effect = lambda route, body=None: (
            {'features': [{'id': 'jira-dodo-aip-1', 'title': 'Old title',
                           'jiraContext': {'version': 'aaaa'},
                           'jiraChanges': [{'field': 'labels', 'before': 'x',
                                            'after': 'y', 'detectedAt': 'earlier'}]}]}
            if route == 'features/list' else {'success': True})
        with patch.object(monitor, 'ensure_worktree_for_branch', return_value='reused'):
            result = monitor.apply_import_tree({'projectPath': '/tmp/proj'}, plan, api)
        update = next(call.args[1] for call in api.call.call_args_list
                      if call.args[0] == 'features/update')
        changes = update['updates']['jiraChanges']
        self.assertEqual(len(changes), 2)               # earlier change kept
        self.assertTrue(any(c['field'] == 'requirements' for c in changes))
        self.assertEqual(result['changed'][0]['id'], 'jira-dodo-aip-1')

    def test_apply_clears_changes_when_jira_matches_again(self):
        card = {'id': 'jira-dodo-aip-1', 'mode': 'execute', 'title': 'AIP-1: T',
                'description': 'd', 'jiraKey': 'AIP-1', 'jiraSubtasks': [],
                'jiraContext': {'version': 'aaaa', 'syncedAt': 'now', 'path': 'ctx.md'},
                'worktree': '/tmp/wt', 'contextMarkdown': 'ctx'}
        api = Mock()
        api.call.side_effect = lambda route, body=None: (
            {'features': [{'id': 'jira-dodo-aip-1', 'title': 'AIP-1: T',
                           'jiraContext': {'version': 'aaaa'},
                           'jiraChanges': [{'field': 'labels', 'before': 'x', 'after': 'y'}]}]}
            if route == 'features/list' else {'success': True})
        with patch.object(monitor, 'ensure_worktree_for_branch', return_value='reused'):
            monitor.apply_import_tree({'projectPath': '/tmp/proj'},
                                      {'branch': 'b', 'worktree': '/tmp/wt',
                                       'cards': [card]}, api)
        update = next(call.args[1] for call in api.call.call_args_list
                      if call.args[0] == 'features/update')
        # A revert does not erase the record: a human acknowledges it explicitly.
        self.assertEqual([c['field'] for c in update['updates']['jiraChanges']], ['labels'])


class JiraChangeAckTests(unittest.TestCase):
    """Reviewed changes are cleared explicitly, per card or by key."""

    def test_plan_lists_only_cards_with_changes(self):
        api = Mock()
        api.call.return_value = {'features': [
            {'id': 'jira-dodo-aip-1', 'jiraKey': 'AIP-1',
             'jiraChanges': [{'field': 'requirements', 'before': 'a', 'after': 'b'}]},
            {'id': 'jira-dodo-aip-2', 'jiraKey': 'AIP-2'},
        ]}
        plan = monitor.jira_change_ack_plan({'projectPath': '/p'}, {}, api)
        self.assertEqual([entry['id'] for entry in plan['plan']], ['jira-dodo-aip-1'])
        self.assertEqual(plan['plan'][0]['changes'][0]['field'], 'requirements')

    def test_target_limits_the_plan_to_one_card(self):
        api = Mock()
        api.call.return_value = {'features': [
            {'id': 'jira-dodo-aip-1', 'jiraKey': 'AIP-1', 'jiraChanges': [{'field': 'labels'}]},
            {'id': 'jira-dodo-aip-2', 'jiraKey': 'AIP-2', 'jiraChanges': [{'field': 'labels'}]},
        ]}
        plan = monitor.jira_change_ack_plan({'projectPath': '/p'}, {}, api, 'AIP-2')
        self.assertEqual([entry['id'] for entry in plan['plan']], ['jira-dodo-aip-2'])

    def test_unknown_target_reports_skipped(self):
        api = Mock()
        api.call.return_value = {'features': [
            {'id': 'jira-dodo-aip-1', 'jiraKey': 'AIP-1'}]}
        plan = monitor.jira_change_ack_plan({'projectPath': '/p'}, {}, api, 'AIP-99')
        self.assertEqual(plan['plan'], [])
        self.assertEqual(len(plan['skipped']), 1)

    def test_apply_clears_changes(self):
        api = Mock()
        api.call.return_value = {'success': True}
        applied = monitor.apply_jira_change_ack_plan(
            {'projectPath': '/p'}, {}, api,
            {'plan': [{'id': 'jira-dodo-aip-1', 'key': 'AIP-1'}]})
        self.assertEqual(applied['cleared'], ['jira-dodo-aip-1'])
        body = api.call.call_args.args[1]
        self.assertEqual(body['updates']['jiraChanges'], [])


if __name__ == '__main__':
    unittest.main()
