import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
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
                       'reasoningEffort': 'medium'}
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
        (self.root / '.worktrees/aip-123-kaka').mkdir(parents=True)
        api = Mock()
        api.call.return_value = {'success': True}
        with patch.object(monitor, 'checked'):
            monitor.dispatch(self.issue, self.config, self.state, self.state_path, api,
                             auto_start=False, label='kaka')
        self.assertEqual(self.state['jobs']['AIP-123']['status'], 'ready')
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

    def test_uncertain_dispatch_is_persisted_and_not_retried(self):
        (self.root / '.worktrees/aip-123-kaka').mkdir(parents=True)
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
                                {'feature': {'status': 'waiting_approval'}}]
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


if __name__ == '__main__':
    unittest.main()
