import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('jira_completion', Path(__file__).with_name('task-consolidation-jira.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class CompletionFieldsTests(unittest.TestCase):
    def setUp(self):
        self.transition = {'id': '121', 'name': 'CLOSED', 'to': {'name': 'Closed', 'statusCategory': {'key': 'done'}}, 'fields': {
            'resolution': {'name': 'Resolution', 'required': True, 'schema': {'type': 'resolution'}, 'allowedValues': [{'id': '1', 'name': 'Fixed'}, {'id': '2', 'name': "Won't Fix"}]},
            'fixVersions': {'name': 'Fix Version/s', 'required': True, 'schema': {'type': 'array', 'items': 'version'}, 'allowedValues': [{'id': '19348', 'name': 'LLM-3.1'}, {'id': '2', 'name': 'Other'}]},
        }}
        self.issue = {'fixVersions': [{'id': '19348', 'name': 'LLM-3.1'}]}
        self.fields = {'resolution': ['1'], 'fixVersions': ['19348']}

    def choice(self):
        return worker.completion_choices([self.transition], self.issue, True)[0]

    def test_required_fields_do_not_hide_closed_and_existing_version_is_preserved(self):
        choice = self.choice()
        self.assertEqual(choice['target'], 'Closed')
        self.assertEqual(choice['fields'][0]['value'], [])
        self.assertEqual(choice['fields'][1]['value'], ['19348'])
        self.assertTrue(all(f['supported'] for f in choice['fields']))

    def test_close_payload_uses_validated_resolution_and_versions(self):
        self.assertEqual(worker.transition_fields(self.choice(), self.fields), {'resolution': {'id': '1'}, 'fixVersions': [{'id': '19348'}]})

    def test_invalid_missing_or_unexpected_values_are_rejected(self):
        for value in [{}, {'resolution': ['9'], 'fixVersions': ['19348']}, {**self.fields, 'summary': ['new']}, {**self.fields, 'resolution': ['1', '2']}, {**self.fields, 'fixVersions': ['19348', '19348']}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                worker.transition_fields(self.choice(), value)

    def test_unsupported_required_field_stays_visible_but_blocks_writes(self):
        self.transition['fields']['customfield_1'] = {'required': True, 'name': 'Approval', 'schema': {'type': 'string'}}
        self.assertFalse(self.choice()['fields'][-1]['supported'])
        with self.assertRaisesRegex(ValueError, 'Approval'):
            worker.transition_fields(self.choice(), self.fields)

    def test_legacy_consolidation_policy_does_not_gain_unfilled_transitions(self):
        self.assertEqual(worker.completion_choices([self.transition], self.issue), [])
        self.transition['fields'] = {}
        self.assertEqual(len(worker.completion_choices([self.transition], self.issue)), 1)

    def test_nonterminal_transitions_are_excluded(self):
        self.transition['to']['statusCategory']['key'] = 'indeterminate'
        self.assertEqual(worker.completion_choices([self.transition], self.issue, True), [])

class JiraRecoveryTests(unittest.TestCase):
    def test_reads_retry_transient_timeouts_but_writes_never_retry(self):
        from unittest.mock import Mock, patch
        import urllib.request
        opener = Mock()
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"ok":true}'
        opener.open.side_effect = [TimeoutError(), response]
        with patch.object(worker.time, 'sleep'):
            self.assertEqual(worker.request_json(opener, urllib.request.Request('https://jira.test')), {'ok': True})
        self.assertEqual(opener.open.call_count, 2)
        opener.reset_mock(side_effect=True)
        opener.open.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            worker.request_json(opener, urllib.request.Request('https://jira.test', data=b'{}'))
        self.assertEqual(opener.open.call_count, 1)

    def test_lost_transition_response_is_reconciled_by_read_without_reposting(self):
        from unittest.mock import Mock
        fields = {'status': {'name': 'Closed', 'statusCategory': {'key': 'done'}}, 'updated': 'now'}
        api = Mock(side_effect=[TimeoutError(), {'fields': fields}])
        self.assertEqual(worker.close_and_confirm(api, {'transition': {'id': '121'}}), fields)
        self.assertEqual(api.call_count, 2)
        self.assertEqual(api.call_args_list[1].args, ('?fields=status,updated,summary',))

    def test_read_failure_after_success_explains_uncertainty(self):
        from unittest.mock import Mock
        with self.assertRaisesRegex(ValueError, 'closure was submitted.*timed out'):
            worker.close_and_confirm(Mock(side_effect=[{}, TimeoutError()]), {})

    def test_post_failure_does_not_claim_closure_if_still_open(self):
        from unittest.mock import Mock
        with self.assertRaisesRegex(ValueError, 'closure is not confirmed'):
            worker.close_and_confirm(Mock(side_effect=[TimeoutError(), {'fields': {'status': {'statusCategory': {'key': 'new'}}}}]), {})

    def test_errors_are_actionable_and_do_not_leak_urls(self):
        import socket
        import urllib.error
        self.assertIn('resolved', worker.jira_error_message(urllib.error.URLError(socket.gaierror())))
        self.assertIn('response format', worker.jira_error_message(KeyError('secret')))
        self.assertNotIn('password', worker.jira_error_message(urllib.error.URLError('https://user:password@jira.test')))
