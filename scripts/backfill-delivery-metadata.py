#!/usr/bin/env python3
"""Backfill changed-project / MR metadata onto existing Automaker features.

Cards render changed repository names (with the MR link on the name) from
``changedProjects`` + ``mergeRequests`` on the feature. New runs get these fields
written by the server when it reads the delivery receipt, but features that
completed before that existed only have the receipt on disk. This script replays
those receipts through the Automaker API.

Usage:
    python3 scripts/backfill-delivery-metadata.py --dry-run
    python3 scripts/backfill-delivery-metadata.py
"""
import argparse
import importlib.util
import json
from pathlib import Path


def load_monitor():
    spec = importlib.util.spec_from_file_location(
        'jira_monitor', Path(__file__).with_name('jira-monitor.py'))
    monitor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(monitor)
    return monitor


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='/workspace/automaker/data/jira-monitor/config.json')
    parser.add_argument('--state', default='/workspace/automaker/data/jira-monitor/state.json')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    monitor = load_monitor()
    config = json.loads(Path(args.config).read_text())
    state = json.loads(Path(args.state).read_text())
    api = monitor.API(config)

    updated, skipped, missing = [], [], []
    for key, job in sorted(state.get('jobs', {}).items()):
        feature_id, worktree = job.get('featureId'), job.get('worktree')
        if not feature_id or not worktree:
            continue
        receipt_path = monitor.receipt_path_for(worktree, feature_id)
        if not receipt_path.is_file():
            missing.append(key)
            continue
        try:
            receipt = json.loads(receipt_path.read_text())
        except (OSError, ValueError) as error:
            print(f'{key}: unreadable receipt {receipt_path}: {error}')
            continue
        projects = monitor.changed_projects_from_receipt(receipt, config)
        if not projects:
            skipped.append(key)
            continue
        merge_requests = [u for u in (receipt.get('mergeRequests') or [])
                          if isinstance(u, str)]
        updates = {'changedProjects': projects, 'mergeRequests': merge_requests}
        if args.dry_run:
            print(f'{key}: {json.dumps(updates, ensure_ascii=False)}')
            updated.append(key)
            continue
        body = {'projectPath': config['projectPath'], 'featureId': feature_id,
                'updates': updates}
        current = api.call('features/get', body).get('feature', {})
        if (current.get('changedProjects') == projects
                and current.get('mergeRequests') == merge_requests):
            skipped.append(key)
            continue
        api.call('features/update', body)
        print(f'{key}: {", ".join(p["name"] for p in projects)}')
        updated.append(key)

    print(f'\nupdated={len(updated)} skipped={len(skipped)} no_receipt={len(missing)}')
    if missing:
        print('no receipt for: ' + ', '.join(missing))


if __name__ == '__main__':
    main()
