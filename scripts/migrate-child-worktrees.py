#!/usr/bin/env python3
"""Merge dispatched child issues back into their parent's worktree (D2).

The monitor used to give every Jira issue its own worktree/branch, so subtasks
ended up split away from their parent (Epic/Story). This pass moves that work
back:

  * cherry-pick the child branch commits onto the parent branch, prefixing each
    commit subject with the child key (`[AIP-114998] feat: ...`) so reviewers can
    tell which card a commit came from;
  * re-point the child feature at the parent branch (`branchName`,
    `jiraParentKey`, `parentFeatureId`);
  * remove the child worktree (the child branch is kept as an archive).

Dirty child worktrees and cherry-pick conflicts are reported and skipped - they
need a human decision. Dry-run by default; pass --apply to execute.

Usage:
  python3 scripts/migrate-child-worktrees.py --config data/jira-monitor/config.json
  python3 scripts/migrate-child-worktrees.py --config ... --apply
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def run(cwd: str | Path, *args: str, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(['git', '-C', str(cwd), *args], capture_output=True, text=True,
                          check=False) if check is False else subprocess.run(
        ['git', '-C', str(cwd), *args], capture_output=True, text=True, check=True)


def git_out(cwd: str | Path, *args: str) -> str:
    return run(cwd, *args).stdout.strip()


def real_dirt(cwd: str | Path) -> list[str]:
    """Dirty entries, ignoring submodule checkouts that drifted from the index.

    These worktrees usually have submodules checked out at a different commit
    than their gitlink (the epic branch advances pointers over time), which git
    reports as ` M <path>`. That is not work in progress and must not block a
    migration that only rewrites gitlinks.
    """
    dirty = []
    for line in run(cwd, 'status', '--porcelain').stdout.splitlines():
        path = line[3:].strip().strip('"')
        if not path:
            continue
        index_entry = git_out(cwd, 'ls-files', '-s', '--', path)
        if index_entry.split(' ', 1)[0] == '160000':
            continue
        dirty.append(line)
    return dirty


def worktree_map(project: str) -> dict[str, str]:
    """branch -> worktree path"""
    mapping: dict[str, str] = {}
    porcelain = run(project, 'worktree', 'list', '--porcelain').stdout
    current = None
    for line in porcelain.splitlines():
        if line.startswith('worktree '):
            current = line.split(' ', 1)[1].strip()
        elif line.startswith('branch ') and current:
            branch = line.split(' ', 1)[1].strip().removeprefix('refs/heads/')
            mapping[branch] = current
    return mapping


def load_features(project: str) -> dict[str, dict]:
    features = {}
    for path in sorted(Path(project, '.automaker', 'features').glob('*/feature.json')):
        try:
            features[path.parent.name] = json.loads(path.read_text())
        except Exception:
            continue
    return features


def subtask_map(features: dict[str, dict]) -> dict[str, str]:
    """Jira subtask key -> parent feature id"""
    mapping: dict[str, str] = {}
    for fid, feature in features.items():
        for subtask in feature.get('jiraSubtasks') or []:
            if isinstance(subtask, dict) and subtask.get('key'):
                mapping[str(subtask['key']).upper()] = fid
    return mapping


def prefix_subject(subject: str, key: str) -> str:
    return subject if re.match(rf'^\[{re.escape(key)}\]', subject) else f'[{key}] {subject}'


def choose_gitlink(parent_worktree: str | Path, path: str) -> tuple[str | None, str]:
    """Pick the winning submodule pointer for a conflicted gitlink.

    A cherry-pick between two branches of the same epic usually conflicts only on
    submodule pointers. The side that advanced the pointer is the correct one:
    take `theirs` when it is a descendant of `ours`, keep `ours` when the reverse
    holds, and refuse to guess when the pointers diverged.
    """
    stages = git_out(parent_worktree, 'ls-files', '-u', '--', path).splitlines()
    ours = theirs = None
    for line in stages:
        meta = line.split('\t', 1)[0].split()
        if len(meta) < 3:
            continue
        mode, sha, stage = meta[0], meta[1], meta[2]
        if mode != '160000':
            return None, f'{path} is not a submodule pointer conflict'
        if stage == '2':
            ours = sha
        elif stage == '3':
            theirs = sha
    if not ours or not theirs:
        return None, f'{path} has no both-side pointer'
    if ours == theirs:
        return ours, ''

    submodule = Path(parent_worktree, path)
    if not (submodule / '.git').exists():
        # Submodules are often cloned but not checked out in this worktree. The
        # objects live in the shared .git/modules store, so a checkout is local.
        run(parent_worktree, 'submodule', 'update', '--init', '--', path)
    if not (submodule / '.git').exists():
        return None, f'{path} submodule is not initialized; cannot compare pointers'
    if run(submodule, 'merge-base', '--is-ancestor', ours, theirs).returncode == 0:
        return theirs, ''
    if run(submodule, 'merge-base', '--is-ancestor', theirs, ours).returncode == 0:
        return ours, ''

    # Both lines advanced the pointer. If a branch on the remote already contains
    # both commits (a later child built on top of them), its tip is the correct
    # integration point - no merge commit and no push needed.
    run(submodule, 'fetch', '--quiet', 'origin')
    branches = [line.strip() for line in
                run(submodule, 'branch', '-r', '--format=%(refname:short)').stdout.splitlines()
                if line.strip()]
    containing = [branch for branch in branches
                  if run(submodule, 'merge-base', '--is-ancestor', ours, branch).returncode == 0
                  and run(submodule, 'merge-base', '--is-ancestor', theirs, branch).returncode == 0]
    if containing:
        def tip_of(branch: str) -> str:
            return git_out(submodule, 'rev-parse', branch)

        newest = max(containing, key=lambda branch: git_out(
            submodule, 'log', '-1', '--format=%ct', tip_of(branch)) or '0')
        return tip_of(newest), ''
    return None, f'{path} pointers diverged ({ours[:10]} vs {theirs[:10]})'


def cherry_pick_with_gitlink_resolution(parent_worktree: str | Path, sha: str, key: str) -> None:
    """Cherry-pick one commit, resolving submodule-pointer conflicts when safe."""
    pick = run(parent_worktree, 'cherry-pick', sha)
    if pick.returncode != 0:
        output = f'{pick.stdout}\n{pick.stderr}'
        if 'empty' in output and 'cherry-pick' in output.lower():
            # The parent branch already contains this change (for example after a
            # merge that brought the whole line in): nothing to apply.
            run(parent_worktree, 'cherry-pick', '--skip')
            return
        conflicts = [line for line in
                     git_out(parent_worktree, 'diff', '--name-only', '--diff-filter=U').splitlines()
                     if line.strip()]
        if not conflicts:
            raise RuntimeError(f'cherry-pick {sha[:10]} failed: {pick.stderr.strip()}')
        for path in conflicts:
            chosen, error = choose_gitlink(parent_worktree, path)
            if error:
                raise RuntimeError(f'cherry-pick {sha[:10]} conflict on {error}')
            run(parent_worktree, 'update-index', '--cacheinfo', f'160000,{chosen},{path}')
            run(parent_worktree, 'submodule', 'update', '--checkout', '--', path)
        cont = run(parent_worktree, '-c', 'core.editor=true', 'cherry-pick', '--continue')
        if cont.returncode != 0:
            cont_output = f'{cont.stdout}\n{cont.stderr}'
            if 'empty' in cont_output:
                run(parent_worktree, 'cherry-pick', '--skip')
                return
            raise RuntimeError(f'cherry-pick {sha[:10]} --continue failed: {cont.stderr.strip()}')

    subject = git_out(parent_worktree, 'log', '-1', '--format=%s')
    body = git_out(parent_worktree, 'log', '-1', '--format=%b')
    message = prefix_subject(subject, key)
    if body:
        message = f'{message}\n\n{body}'
    run(parent_worktree, 'commit', '--amend', '-m', message)


def linked_parent_map(features: dict[str, dict]) -> dict[str, str]:
    """child Jira key -> parent feature id, for cards linked through their parent.

    The importer links a card to its parent issue (`parentJiraKey` /
    `parentFeatureId`) instead of only listing subtasks on the parent. Stories of
    an epic and tasks of a story are both migrated that way.
    """
    by_key = {str(f.get('jiraKey') or '').upper(): fid
              for fid, f in features.items() if f.get('jiraKey')}
    mapping: dict[str, str] = {}
    for fid, feature in features.items():
        key = str(feature.get('jiraKey') or '').upper()
        if not key:
            continue
        parent_id = feature.get('parentFeatureId')
        if isinstance(parent_id, str) and parent_id in features and parent_id != fid:
            mapping[key] = parent_id
            continue
        parent_key = str(feature.get('parentJiraKey') or feature.get('jiraParentKey') or '').upper()
        if parent_key and parent_key in by_key and by_key[parent_key] != fid:
            mapping[key] = by_key[parent_key]
    return mapping


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text())
    project = config['projectPath']
    features = load_features(project)
    parents = {**subtask_map(features), **linked_parent_map(features)}
    worktrees = worktree_map(project)

    plan, skipped, errors = [], [], []
    for child_id, child in sorted(features.items()):
        key = str(child.get('jiraKey') or '').upper()
        parent_id = parents.get(key)
        if not parent_id or parent_id not in features:
            continue
        child_branch = str(child.get('branchName') or '')
        parent_branch = str(features[parent_id].get('branchName') or '')
        if not child_branch or not parent_branch or child_branch == parent_branch:
            continue

        child_worktree = worktrees.get(child_branch)
        parent_worktree = worktrees.get(parent_branch) or str(
            Path(project, '.worktrees', parent_branch.replace('/', '-')))

        if child_worktree:
            # Ignore drifted submodule checkouts here too: a pure re-point never
            # writes to the child worktree, and the epic branch moves gitlinks.
            dirty = real_dirt(child_worktree)
            if dirty:
                skipped.append({'key': key, 'child': child_id, 'reason': 'dirty worktree',
                                'details': dirty[:5]})
                continue

        commits = [line.split()[0] for line in
                   git_out(project, 'log', '--reverse', '--format=%H', f'origin/dev..{child_branch}').splitlines()
                   if line.strip()]
        # No commits and a clean worktree means the branch was only prepared: the
        # card can be re-pointed at the parent branch and the empty checkout
        # removed, which is what unifies the worktree view.

        entry = {'key': key, 'child': child_id, 'parent': parent_id,
                 'childBranch': child_branch, 'parentBranch': parent_branch,
                 'childWorktree': child_worktree, 'parentWorktree': parent_worktree,
                 'commits': []}
        for sha in commits:
            subject = git_out(project, 'log', '-1', '--format=%s', sha)
            body = git_out(project, 'log', '-1', '--format=%b', sha)
            entry['commits'].append({'sha': sha[:10], 'subject': prefix_subject(subject, key),
                                     'bodyLines': len(body.splitlines())})
        plan.append(entry)

    print(f'{"DRY RUN" if not args.apply else "APPLY"}: {len(plan)} child feature(s) to migrate, '
          f'{len(skipped)} skipped, {len(errors)} error(s)')
    for entry in plan:
        print(f"  {entry['key']:12} {entry['childBranch']:26} -> {entry['parentBranch']:24} "
              f"commits={len(entry['commits'])}")
        for commit in entry['commits']:
            print(f"      {commit['sha']} -> {commit['subject'][:90]}")
    for item in skipped:
        print(f"  SKIP {item['key']:12} {item['reason']}")
        for line in item.get('details', []):
            print(f"        {line}")

    if not args.apply:
        print('\nDry run only. Re-run with --apply to execute.')
        return 0

    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    applied, failed = [], []
    for entry in plan:
        parent_worktree = entry['parentWorktree']
        Path(parent_worktree).parent.mkdir(parents=True, exist_ok=True)
        if not Path(parent_worktree, '.git').exists():
            result = run(project, 'worktree', 'add', parent_worktree, entry['parentBranch'])
            if result.returncode != 0:
                failed.append({'key': entry['key'], 'error': f'worktree add failed: {result.stderr.strip()}'})
                continue
        parent_dirty = real_dirt(parent_worktree)
        # A pure re-point (nothing to cherry-pick) never writes to this worktree,
        # so a dirty checkout - typically drifted submodule pointers - is fine.
        if parent_dirty and entry['commits']:
            failed.append({'key': entry['key'],
                           'error': 'parent worktree is dirty; commit or stash it first'})
            continue

        try:
            run(project, 'tag', f'backup/{entry["childBranch"].replace("/", "-")}-{stamp}',
                entry['childBranch'])
            for commit in entry['commits']:
                cherry_pick_with_gitlink_resolution(parent_worktree, commit['sha'], entry['key'])

            # Re-point the child feature at the parent branch/worktree.
            feature_file = Path(project, '.automaker', 'features', entry['child'], 'feature.json')
            child = json.loads(feature_file.read_text())
            child['branchName'] = entry['parentBranch']
            parent_feature = features.get(entry['parent']) or {}
            parent_jira_key = str(parent_feature.get('jiraKey') or '').upper()
            if parent_jira_key:
                child['jiraParentKey'] = parent_jira_key
            child['parentFeatureId'] = entry['parent']
            child['migratedFromBranch'] = entry['childBranch']
            feature_file.write_text(json.dumps(child, indent=2, ensure_ascii=False) + '\n')

            if entry['childWorktree'] and Path(entry['childWorktree']).exists():
                removed = run(project, 'worktree', 'remove', entry['childWorktree'])
                if removed.returncode != 0:
                    print(f"  PRESERVED {entry['childWorktree']}: {removed.stderr.strip()}")

            applied.append(entry['key'])
        except Exception as error:  # noqa: BLE001 - keep going, report per feature
            run(parent_worktree, 'cherry-pick', '--abort')
            failed.append({'key': entry['key'], 'error': str(error)})

    print(f'\napplied: {len(applied)} {applied}')
    for item in failed:
        print(f"  FAILED {item['key']}: {item['error']}")
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
