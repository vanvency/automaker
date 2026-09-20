#!/usr/bin/env python3
"""Finish the D2 child-worktree migration.

Retries child-worktree migration only when histories can be reconciled safely.
Dirty worktrees, divergent gitlinks and source-file conflicts require manual resolution.
Git refuses unsafe worktree removal; preserve that checkout instead of forcing deletion.

Dry-run by default; pass --apply to execute.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def run(cwd: str | Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['git', '-C', str(cwd), *args], capture_output=True, text=True)


def out(cwd: str | Path, *args: str) -> str:
    return run(cwd, *args).stdout.strip()


def ok(cwd: str | Path, *args: str) -> bool:
    return run(cwd, *args).returncode == 0


def worktrees(project: str) -> dict[str, str]:
    mapping, current = {}, None
    for line in out(project, 'worktree', 'list', '--porcelain').splitlines():
        if line.startswith('worktree '):
            current = line.split(' ', 1)[1].strip()
        elif line.startswith('branch ') and current:
            mapping[line.split(' ', 1)[1].strip().removeprefix('refs/heads/')] = current
    return mapping


def commit_meta(project: str, sha: str) -> tuple[str, str]:
    subject = out(project, 'log', '-1', '--format=%s', sha)
    body = out(project, 'log', '-1', '--format=%b', sha)
    return subject, body


def prefix_subject(subject: str, key: str) -> str:
    return subject if re.match(rf'^\[{re.escape(key)}\]', subject) else f'[{key}] {subject}'


def resolve_gitlink_conflict(project: str, path: str, ours: str, theirs: str) -> tuple[str, str]:
    """Return (resolved_sha, note) for a submodule pointer conflict."""
    sub = Path(project, path)
    note = ''
    if ours and theirs and (sub / '.git').exists():
        theirs_contains_ours = ok(sub, 'merge-base', '--is-ancestor', ours, theirs)
        ours_contains_theirs = ok(sub, 'merge-base', '--is-ancestor', theirs, ours)
        if ours == theirs:
            return ours, 'identical'
        if theirs_contains_ours:
            return theirs, 'child pointer is newer (descendant)'
        if ours_contains_theirs:
            return ours, 'parent pointer already contains the child pointer'
        raise RuntimeError(f'Divergent submodule histories at {path}; resolve explicitly')
    raise RuntimeError(f'Cannot verify submodule ancestry at {path}; preserve both pointers')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text())
    project = config['projectPath']
    wtmap = worktrees(project)

    features = {}
    for path in sorted(Path(project, '.automaker', 'features').glob('*/feature.json')):
        features[path.parent.name] = (path, json.loads(path.read_text()))

    subtask_of = {}
    for fid, (_p, feature) in features.items():
        for subtask in feature.get('jiraSubtasks') or []:
            if isinstance(subtask, dict) and subtask.get('key'):
                subtask_of[str(subtask['key']).upper()] = fid

    todo, migrated, notes, failures = [], [], [], []
    for fid, (path, feature) in sorted(features.items()):
        key = str(feature.get('jiraKey') or '').upper()
        parent_id = subtask_of.get(key)
        if not parent_id or parent_id not in features:
            continue
        parent_feature = features[parent_id][1]
        child_branch = str(feature.get('branchName') or '')
        parent_branch = str(parent_feature.get('branchName') or '')
        if not child_branch or not parent_branch or child_branch == parent_branch:
            continue
        todo.append({'fid': fid, 'key': key, 'path': path, 'feature': feature,
                     'parent_id': parent_id, 'parent_feature': parent_feature,
                     'child_branch': child_branch, 'parent_branch': parent_branch,
                     'child_worktree': wtmap.get(child_branch),
                     'parent_worktree': wtmap.get(parent_branch) or str(
                         Path(project, '.worktrees', parent_branch.replace('/', '-')))})

    print(f'{"DRY RUN" if not args.apply else "APPLY"}: {len(todo)} child feature(s) remaining')
    for item in todo:
        commits = [l.split()[0] for l in
                   out(project, 'log', '--reverse', '--format=%H',
                       f'origin/dev..{item["child_branch"]}').splitlines() if l.strip()]
        item['commits'] = commits
        print(f"  {item['key']:12} {item['child_branch']:26} -> {item['parent_branch']:24} commits={len(commits)}")

    if not args.apply:
        print('\nDry run only. Re-run with --apply to execute.')
        return 0

    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    for item in todo:
        key, parent_worktree = item['key'], item['parent_worktree']
        try:
            Path(parent_worktree).parent.mkdir(parents=True, exist_ok=True)
            if not Path(parent_worktree, '.git').exists():
                added = run(project, 'worktree', 'add', parent_worktree, item['parent_branch'])
                if added.returncode != 0:
                    raise RuntimeError(f'worktree add failed: {added.stderr.strip()}')
            if out(parent_worktree, 'status', '--porcelain'):
                raise RuntimeError('parent worktree is dirty')

            # Never discard uncommitted work during migration.
            child_worktree = item['child_worktree']
            if child_worktree and Path(child_worktree).exists():
                if out(child_worktree, 'status', '--porcelain'):
                    raise RuntimeError('child worktree is dirty; preserve or commit changes first')

            if item['commits']:
                run(project, 'tag', f'backup/{item["child_branch"].replace("/", "-")}-{stamp}',
                    item['child_branch'])
            for sha in item['commits']:
                pick = run(parent_worktree, 'cherry-pick', sha)
                if pick.returncode != 0:
                    conflicts = out(parent_worktree, 'diff', '--name-only', '--diff-filter=U').split()
                    if not conflicts:
                        raise RuntimeError(f'cherry-pick {sha[:8]} failed: {pick.stderr.strip()}')
                    for path in conflicts:
                        ours = out(project, 'rev-parse', f'{item["parent_branch"]}:{path}')
                        theirs = out(project, 'rev-parse', f'{item["child_branch"]}:{path}')
                        is_gitlink = bool(out(project, 'ls-tree', item['parent_branch'], path)) and \
                            out(project, 'ls-tree', item['parent_branch'], path).startswith('160000')
                        if is_gitlink:
                            resolved, note = resolve_gitlink_conflict(project, path, ours, theirs)
                            run(parent_worktree, 'update-index', '--cacheinfo', f'160000,{resolved},{path}')
                            if note:
                                notes.append({'key': key, 'path': path, 'note': note,
                                              'resolved': resolved[:8]})
                        else:
                            raise RuntimeError(f'Source conflict at {path}; manual resolution required')
                        run(parent_worktree, 'add', '--', path)
                    continued = run(parent_worktree, 'cherry-pick', '--continue', '--no-edit')
                    if continued.returncode != 0:
                        raise RuntimeError(f'cherry-pick --continue failed: {continued.stderr.strip()}')

                # Tag the commit with its child key (amend the message).
                subject, body = commit_meta(parent_worktree, 'HEAD')
                message = prefix_subject(subject, key)
                if body:
                    message = f'{message}\n\n{body}'
                run(parent_worktree, 'commit', '--amend', '-m', message)

            # Re-point the child feature at the parent branch.
            path, feature = item['path'], item['feature']
            feature['branchName'] = item['parent_branch']
            parent_key = str(item['parent_feature'].get('jiraKey') or '').upper()
            if parent_key:
                feature['jiraParentKey'] = parent_key
            feature['parentFeatureId'] = item['parent_id']
            feature['migratedFromBranch'] = item['child_branch']
            feature['migratedAt'] = datetime.now().isoformat()
            path.write_text(json.dumps(feature, indent=2, ensure_ascii=False) + '\n')

            if child_worktree and Path(child_worktree).exists():
                removed = run(project, 'worktree', 'remove', child_worktree)
                if removed.returncode != 0:
                    notes.append({'key': key, 'path': child_worktree, 'note': 'Preserved old checkout: ' + removed.stderr.strip(), 'resolved': ''})

            migrated.append(key)
        except Exception as error:  # noqa: BLE001
            run(parent_worktree, 'cherry-pick', '--abort')
            failures.append({'key': key, 'error': str(error)})

    print(f'\nmigrated: {len(migrated)} -> {migrated}')
    for note in notes:
        print(f"  NOTE {note['key']} {note['path']}: {note['note']} (resolved {note['resolved']})")
    for failure in failures:
        print(f"  FAILED {failure['key']}: {failure['error']}")
    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(main())
