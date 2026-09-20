import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'jira_import_rules', Path(__file__).with_name('jira_import_rules.py'))
rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules)

CONFIG = {'jiraProject': 'AIP', 'jiraLabels': {'autoStart': ['dodo'], 'manualStart': ['kaka']}}


def issue(key, labels=(), subtask=False, parent=None):
    fields = {'labels': list(labels),
              'issueType': {'name': 'Sub-task' if subtask else 'Story', 'subtask': subtask}}
    if parent:
        fields['parent'] = {'key': parent}
    return {'key': key, 'fields': fields}


class AdmissionTests(unittest.TestCase):
    def test_root_with_label_is_imported(self):
        admission, _ = rules.classify_scan_hit(issue('AIP-1', ['dodo']), CONFIG)
        self.assertEqual(admission, rules.IMPORTED)

    def test_root_without_label_is_recorded_not_imported(self):
        admission, reason = rules.classify_scan_hit(issue('AIP-1'), CONFIG)
        self.assertEqual(admission, rules.NO_ROOT_LABEL)
        self.assertIn('without a monitored label', reason)

    def test_subtask_is_imported_through_its_labelled_parent(self):
        parent = issue('AIP-1', ['dodo'])
        admission, reason = rules.classify_scan_hit(
            issue('AIP-2', ['dodo'], subtask=True, parent='AIP-1'), CONFIG, parent)
        self.assertEqual(admission, rules.SKIPPED_SUBTASK)
        self.assertIn('importing AIP-1 instead', reason)

    def test_label_only_on_subtask_is_recorded_for_a_human(self):
        parent = issue('AIP-1')
        admission, reason = rules.classify_scan_hit(
            issue('AIP-2', ['dodo'], subtask=True, parent='AIP-1'), CONFIG, parent)
        self.assertEqual(admission, rules.LABEL_ON_SUBTASK_ONLY)
        self.assertIn('parent AIP-1 is unlabelled', reason)

    def test_subtask_without_parent_detail_is_still_not_a_root(self):
        admission, _ = rules.classify_scan_hit(
            issue('AIP-2', ['kaka'], subtask=True, parent='AIP-1'), CONFIG)
        self.assertEqual(admission, rules.LABEL_ON_SUBTASK_ONLY)

    def test_parent_key_parsing_accepts_str_and_dict(self):
        self.assertEqual(rules.parent_key_of({'parent': {'key': 'aip-114879'}}), 'AIP-114879')
        self.assertEqual(rules.parent_key_of({'parent': 'AIP-114879'}), 'AIP-114879')
        self.assertIsNone(rules.parent_key_of({}))
        self.assertIsNone(rules.parent_key_of({'parent': {'key': 'not-a-key'}}))

    def test_legacy_single_label_config_still_matches(self):
        admission, _ = rules.classify_scan_hit(
            issue('AIP-1', ['kaka']), {'jiraLabel': 'kaka'})
        self.assertEqual(admission, rules.IMPORTED)


class DescendantContextTests(unittest.TestCase):
    def test_grandchild_context_is_folded_into_the_parent(self):
        parent = {'key': 'AIP-2', 'fields': {'summary': 'subtask', 'description': 'parent body'}}
        grandchild = {'key': 'AIP-3',
                      'fields': {'summary': 'grandchild', 'description': 'grandchild body'}}

        merged = rules.merge_descendant_context(parent, [grandchild])

        self.assertIn('parent body', merged)
        self.assertIn('AIP-3: grandchild', merged)
        self.assertIn('grandchild body', merged)

    def test_no_children_keeps_the_parent_text(self):
        parent = {'key': 'AIP-2', 'fields': {'summary': 's', 'description': 'd'}}
        self.assertEqual(rules.merge_descendant_context(parent, []), 's\n\nd')


class ImportHistoryTests(unittest.TestCase):
    def test_history_is_append_only_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'import-history.jsonl'
            rules.append_import_history(path, [
                rules.history_entry('AIP-2', rules.LABEL_ON_SUBTASK_ONLY, 'reason one'),
            ])
            rules.append_import_history(path, [
                rules.history_entry('AIP-1', rules.IMPORTED, 'reason two',
                                    subtask_keys=['AIP-2']),
            ])

            lines = [json.loads(line) for line in path.read_text().splitlines()]

        self.assertEqual([item['key'] for item in lines], ['AIP-2', 'AIP-1'])
        self.assertEqual(lines[1]['subtaskKeys'], ['AIP-2'])

    def test_empty_history_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'import-history.jsonl'
            self.assertEqual(rules.append_import_history(path, []), 0)
            self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
