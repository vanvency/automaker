#!/usr/bin/env python3
"""Reconcile merge requests after the child-worktree migration (D2).

Child issues used to open their own MRs from their own branches. Their commits
now live on the parent branch, so this pass:

  1. ensures every parent branch has one open draft MR targeting dev (created
     from the parent branch when missing, reused when it already exists);
  2. closes every child-branch MR with a note pointing at that parent MR.

Dry-run by default; pass --apply to execute.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path


def api(config: dict, method: str, path: str, payload: dict | None = None):
    token = Path(config.get('gitlabTokenFile') or '/root/gitlab-token').read_text().strip()
    url = f"https://{config['gitlabHost']}/api/v4{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={
        'PRIVATE-TOKEN': token,
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode()
            return json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace')[:300]
        raise RuntimeError(f'{method} {path} -> HTTP {error.code}: {detail}') from error


def load_features(project: str) -> dict[str, dict]:
    features = {}
    for path in sorted(Path(project, '.automaker', 'features').glob('*/feature.json')):
        features[path.parent.name] = json.loads(path.read_text())
    return features


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text())
    project_path = config['projectPath']
    target = config.get('targetBranch') or 'dev'
    features = load_features(project_path)

    parents_by_branch = {
        str(f.get('branchName')): f
        for f in features.values()
        # A parent is a monitor feature that is not itself a child (children carry
        # the same branch after the D2 migration).
        if f.get('id', '').startswith('jira-')
        and f.get('branchName')
        and not f.get('parentFeatureId')
    }

    # (project, parent branch) -> children/MRs
    groups: dict[tuple[str, str], dict] = defaultdict(lambda: {'children': [], 'mrs': []})
    for fid, feature in features.items():
        if not feature.get('parentFeatureId'):
            continue
        branch = str(feature.get('branchName') or '')
        for url in feature.get('mergeRequests') or []:
            match = re.match(r'^https?://[^/]+/(.+?)/-/merge_requests/(\d+)$', str(url))
            if not match:
                continue
            key = (match.group(1), branch)
            groups[key]['children'].append(str(feature.get('jiraKey') or fid))
            groups[key]['mrs'].append(int(match.group(2)))

    print(f'{"DRY RUN" if not args.apply else "APPLY"}: {len(groups)} parent branch(es), '
          f'{sum(len(g["mrs"]) for g in groups.values())} child MR(s)')

    created, reused, closed, errors = [], [], [], []
    for (project, branch), group in sorted(groups.items()):
        encoded = urllib.parse.quote(project, safe='')
        parent = parents_by_branch.get(branch) or {}
        parent_key = str(parent.get('jiraKey') or branch)
        title = f'Draft: {parent_key} {parent.get("title") or branch}'
        existing = api(config, 'GET',
                       f'/projects/{encoded}/merge_requests?state=opened'
                       f'&source_branch={urllib.parse.quote(branch, safe="")}'
                       f'&target_branch={urllib.parse.quote(target, safe="")}')
        print(f"  {'reuse' if existing else 'create'} {project:30} {branch:26} "
              f"children={sorted(set(group['children']))}")
        if not args.apply:
            continue

        try:
            if existing:
                mr = existing[0]
                reused.append((project, branch, mr['iid']))
            else:
                description = (
                    f'合并后的交付分支：`{branch}`（child worktree 迁移 D2）。\n\n'
                    f'原各子任务 MR 已关闭，工作内容都在本分支上（提交标题带 `[任务号]` 前缀）：\n'
                    + '\n'.join(f'- {child}' for child in sorted(set(group['children'])))
                )
                mr = api(config, 'POST', f'/projects/{encoded}/merge_requests', {
                    'source_branch': branch,
                    'target_branch': target,
                    'title': title,
                    'description': description,
                })
                created.append((project, branch, mr['iid'], mr['web_url']))

            for iid in sorted(set(group['mrs'])):
                try:
                    api(config, 'POST', f'/projects/{encoded}/merge_requests/{iid}/notes', {
                        'body': (f'该子任务的工作已迁移到父分支 `{branch}`，'
                                 f'请在 !{mr["iid"]} 继续评审（本 MR 自动关闭）。'),
                    })
                    api(config, 'PUT', f'/projects/{encoded}/merge_requests/{iid}',
                        {'state_event': 'close'})
                    closed.append((project, iid))
                except RuntimeError as error:
                    errors.append({'project': project, 'mr': iid, 'error': str(error)})
        except RuntimeError as error:
            errors.append({'project': project, 'branch': branch, 'error': str(error)})

    if not args.apply:
        print('\nDry run only. Re-run with --apply to execute.')
        return 0

    print(f'\ncreated: {len(created)}')
    for item in created:
        print('  +', item)
    print(f'\nreused: {len(reused)} {reused}')
    print(f'\nclosed child MRs: {len(closed)}')
    for item in errors:
        print('  ERROR', item)
    return 0 if not errors else 1


if __name__ == '__main__':
    sys.exit(main())
