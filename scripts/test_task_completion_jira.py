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
