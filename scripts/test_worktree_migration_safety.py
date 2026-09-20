import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('finish_migration', Path(__file__).with_name('finish-child-worktree-migration.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class MigrationSafetyTests(unittest.TestCase):
    def test_divergent_gitlinks_are_never_chosen_by_timestamp(self):
        with tempfile.TemporaryDirectory() as directory:
            sub = Path(directory, 'sub')
            sub.mkdir()
            (sub / '.git').touch()
            with patch.object(worker, 'ok', return_value=False):
                with self.assertRaisesRegex(RuntimeError, 'Divergent'):
                    worker.resolve_gitlink_conflict(directory, 'sub', 'a' * 40, 'b' * 40)

    def test_missing_submodule_history_does_not_guess_a_pointer(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'Cannot verify'):
                worker.resolve_gitlink_conflict(directory, 'missing', 'a' * 40, 'b' * 40)

    def test_proven_descendant_is_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            sub = Path(directory, 'sub')
            sub.mkdir()
            (sub / '.git').touch()
            with patch.object(worker, 'ok', side_effect=[True, False]):
                sha, _ = worker.resolve_gitlink_conflict(directory, 'sub', 'a' * 40, 'b' * 40)
            self.assertEqual(sha, 'b' * 40)
