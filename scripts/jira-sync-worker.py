#!/usr/bin/env python3
"""Managed Jira worker: JSON stdin/stdout, shared legacy lock, no state ownership overlap."""
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('jira_monitor', Path(__file__).with_name('jira-monitor.py'))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def identity(config, issue_id):
    return hashlib.sha256(json.dumps(
        [config['jiraUrl'].rstrip('/'), str(issue_id), config['projectPath']],
        separators=(',', ':')).encode()).hexdigest()


METADATA_FIELDS = ('title', 'jiraKey', 'jiraUrl', 'jiraIssueId', 'jiraInstanceUrl',
                   'jiraType', 'jiraLabels', 'jiraAssignee', 'jiraSubtasks',
                   'parentJiraKey', 'epicJiraKey', 'issueType', 'jiraStatus', 'jiraDelivery')


def changes_for(existing, card, run_id):
    """Only Jira-owned fields. Execution/session/acceptance fields never enter updates."""
    if existing.get('archive') or existing.get('supersededBy') or existing.get('consolidationPlanId'):
        return {}
    updates = {k: card[k] for k in METADATA_FIELDS
               if k in card and existing.get(k) != card[k]}
    old_context = existing.get('jiraContext') or {}
    new_context = card.get('jiraContext') or {}
    if old_context.get('version') != new_context.get('version'):
        updates['jiraContext'] = new_context
        never_started = (existing.get('status', 'backlog') == 'backlog'
                         and not existing.get('startedAt')
                         and not existing.get('providerSessionId')
                         and not existing.get('summary'))
        if never_started:
            updates['description'] = card['description']
        else:
            updates['jiraPendingDescription'] = card['description']
    if updates:
        changes = monitor.jira_change_summary(card, existing)
        previous = existing.get('jiraChanges') or []
        updates['jiraChanges'] = previous + [
            c for c in changes if not any(
                all(p.get(k) == c.get(k) for k in ('field', 'before', 'after')) for p in previous)]
        fields = sorted(k for k in updates if k != 'jiraChanges')
        updates['jiraSyncHistory'] = (existing.get('jiraSyncHistory') or [])[-29:] + [{
            'runId': run_id, 'at': monitor.now(), 'actor': 'jira-sync',
            'action': 'update', 'fields': fields,
            'reason': 'Jira snapshot updated; execution state and conversation preserved',
        }]
    return updates


class ManagedAPI:
    def __init__(self, config, state=None, state_path=None):
        self.api = monitor.API(config)
        self.state = state
        self.state_path = state_path

    def call(self, route, body):
        if route == 'features/update':
            # Older question-handling code must never own execution state.
            body = dict(body, updates={k: v for k, v in body.get('updates', {}).items()
                                      if k not in ('status', 'error', 'summary', 'executionNotice')})
        if route == 'auto-mode/follow-up-feature' and self.state is not None:
            job = next((j for j in self.state['jobs'].values()
                        if j.get('featureId') == body['featureId']), None)
            if job:
                if job.get('humanAnswerClaim'):
                    raise RuntimeError('Human reply delivery was already claimed; inspect before retry')
                job['humanAnswerClaim'] = monitor.now()
                monitor.save(self.state_path, self.state)
        return self.api.call(route, body)


def delivery_plan(config, root_key, features, label):
    """One matched parent issue is one delivery card; Jira alone supplies its children."""
    detail = monitor.issue_detail(config, root_key)
    if not detail:
        raise RuntimeError(f'Jira issue {root_key} not found')
    fields = detail.get('fields') or {}
    # Children carry no dispatch label of their own, so the split is scanned from
    # the Jira hierarchy instead of from the labelled sweep.
    subtasks = monitor.descendant_subtasks(config, detail)
    chain = monitor.jira_lineage(config, root_key) or {}
    # Delivery scope stays on this issue, but its workspace belongs to the Epic.
    # Existing divergent branches need an explicit, content-preserving migration;
    # never silently move a live/dirty checkout during a Jira metadata sync.
    anchor = chain.get('epic') or detail
    root_card = next((f for f in features if f.get('jiraKey') == root_key), None)
    anchor_card = next((f for f in features
                        if f.get('jiraKey') == anchor['key'] and f.get('branchName')), None)
    shared_card = anchor_card or next((f for f in features
        if f.get('epicJiraKey') == anchor['key'] and f.get('branchName')
        and anchor['key'].lower() in f['branchName'].lower()
        and not f.get('archive') and not f.get('supersededBy')
        and not f.get('jiraDelivery', {}).get('worktreeMismatch')), None)
    anchor_label = (monitor.preferred_label(config, anchor)
                    if anchor['key'] != root_key else label)
    expected_branch = ((shared_card or {}).get('branchName')
                       or monitor.branch_name(anchor, anchor['key'], config, anchor_label))
    branch = (root_card or {}).get('branchName') or expected_branch
    worktree = monitor.worktree_path_for_branch(
        config, branch, str(Path(config['projectPath']) / '.worktrees' / branch.replace('/', '-')))
    feature_id = f'jira-{label}-{root_key.lower()}'
    context_path = f'.automaker/jira-context/{feature_id}/context.md'
    requires_decision = monitor.is_parent_issue(detail) and not subtasks
    description = monitor.task_description(
        detail, dict(config, subtaskCards=False), worktree, branch,
        detail=detail, allow_decomposition=False, subtasks=subtasks)
    delivery = {
        'issueKey': root_key, 'subtaskKeys': [s['key'] for s in subtasks],
        'branch': branch, 'worktree': worktree, 'requiresDecision': requires_decision,
        'rule': 'parent-with-jira-subtasks',
    }
    if branch != expected_branch:
        delivery['worktreeMismatch'] = {
            'epicKey': anchor['key'], 'currentBranch': branch,
            'expectedBranch': expected_branch,
            'expectedWorktree': monitor.worktree_path_for_branch(
                config, expected_branch, str(Path(config['projectPath']) / '.worktrees'
                                            / expected_branch.replace('/', '-'))),
        }
    version = hashlib.sha256(json.dumps({
        'ancestors': monitor.lineage_version(chain or {'task': detail}),
        'summary': fields.get('summary'), 'description': fields.get('description'),
        'subtasks': subtasks,
    }, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
    return {'cards': [{
        'id': feature_id, 'jiraKey': root_key, 'jiraUrl': config['jiraUrl'] + '/browse/' + root_key,
        'title': f'{root_key}: {fields.get("summary") or ""}', 'category': f'Jira {config["jiraProject"]} / {label}',
        'status': 'backlog', 'branchName': branch, 'worktree': worktree,
        'description': description, 'model': config['model'],
        'reasoningEffort': config['reasoningEffort'], 'planningMode': 'skip',
        'skipTests': False, 'requirePlanApproval': False,
        'jiraType': monitor.jira_work_type(monitor.issue_type(fields), config),
        'issueType': monitor.issue_type(fields), 'jiraLabels': monitor.issue_labels(fields),
        'jiraSubtasks': subtasks, 'jiraAssignee': monitor.issue_assignee(fields)[0] or None,
        'epicJiraKey': (chain.get('epic') or {}).get('key'),
        'parentJiraKey': (chain.get('epic') or {}).get('key'),
        'jiraImported': True, 'jiraDelivery': delivery, 'dependencies': [],
        # Policy version forces old unsafe prompts into pending review, never replacing an active prompt.
        'jiraContext': {'version': 'parent-delivery-v1:' + version,
                        'path': context_path, 'syncedAt': monitor.now()},
        'contextMarkdown': monitor.lineage_context_markdown(chain or {'task': detail}, config),
    }]}


def build_plan(config, api, state, run_id):
    # Managed sync always follows the Jira-subtask delivery policy. The
    # hierarchy-import switches are only for explicit CLI tree imports.
    config = dict(config, executionUnit='story', worktreeScope='epic', subtaskCards=False)
    issues = monitor.search(config)
    features = api.call('features/list', {'projectPath': config['projectPath']}).get('features', [])
    plans, changes, seen = [], [], set()
    for issue in issues:
        fields = issue.get('fields') or {}
        if fields.get('parent') or monitor.is_subtask_issue(issue):
            changes.append({'issueKey': issue['key'], 'action': 'skip',
                            'reason': 'Subtask is imported through its parent; no independent root card'})
            continue
        mode, label = monitor.issue_mode(issue, config)
        plan = delivery_plan(config, issue['key'], features, label)
        if plan.get('error'):
            raise RuntimeError(plan['error'])
        for card in plan['cards']:
            detail = monitor.issue_detail(config, card['jiraKey'])
            if not detail or not detail.get('id'):
                raise RuntimeError(f"Missing immutable Jira issue ID for {card['jiraKey']}")
            ident = identity(config, detail['id'])
            if ident in seen:
                continue
            seen.add(ident)
            card.update(jiraIssueId=str(detail['id']), jiraInstanceUrl=config['jiraUrl'].rstrip('/'),
                        jiraStatus=(detail.get('fields', {}).get('status') or {}).get('name', ''))
            # Legacy cards predate immutable identity; adopt their existing id and branch.
            matches = [f for f in features if (
                (str(f.get('jiraIssueId', '')) == str(detail['id'])
                 and f.get('jiraInstanceUrl') == card['jiraInstanceUrl'])
                or (not f.get('jiraIssueId') and f.get('jiraKey') == card['jiraKey']
                    and str(f.get('jiraUrl', '')).startswith(config['jiraUrl'].rstrip('/') + '/')))]
            if len(matches) > 1:
                changes.append({'issueKey': card['jiraKey'], 'action': 'blocked',
                                'reason': 'Multiple existing cards match this issue; manual reconciliation required'})
                continue
            existing = matches[0] if matches else None
            if existing and (existing.get('archive') or existing.get('supersededBy') or existing.get('consolidationPlanId')):
                changes.append({'issueKey': card['jiraKey'], 'featureId': existing['id'],
                                'action': 'skip', 'reason': 'Human-confirmed coverage or consolidation lock; never redispatch'})
                continue
            legacy_job = state.get('jobs', {}).get(card['jiraKey'], {})
            if not existing and legacy_job.get('status') in ('collapsed_into_parent', 'missing_feature'):
                changes.append({'issueKey': card['jiraKey'], 'action': 'skip',
                                'reason': 'Previously collapsed or removed card; retained migration history prevents recreation'})
                continue
            original_id = card['id']
            if existing:
                card['id'] = existing['id']
                card['branchName'] = existing.get('branchName') or card['branchName']
                card['worktree'] = monitor.worktree_path_for_branch(
                    config, card['branchName'], card['worktree'])
            else:
                card['id'] = 'jira-' + ident[:24]
            original_context = card['jiraContext']['path']
            card['jiraContext']['path'] = f".automaker/jira-context/{card['id']}/context.md"
            card['description'] = card['description'].replace(original_context, card['jiraContext']['path'])
            card['description'] = card['description'].replace(original_id, card['id'])
            # Configurable target branch must also reach generated delivery instructions.
            card['description'] = card['description'].replace('targeting dev', 'targeting ' + config['targetBranch'])
            card['description'] = card['description'].replace('origin dev', 'origin ' + config['targetBranch'])
            card['description'] = card['description'].replace('origin/dev', 'origin/' + config['targetBranch'])
            card['description'] = card['description'].replace('MR to dev', 'MR to ' + config['targetBranch'])
            card['description'] = card['description'].replace('modify dev directly', 'modify ' + config['targetBranch'] + ' directly')
            if card.get('jiraDelivery'):
                card['jiraDelivery'].update(branch=card['branchName'], worktree=card['worktree'])
                # Existing independent subtask cards must not be silently absorbed and executed twice.
                separate = [f['id'] for f in features if f.get('jiraKey') in card['jiraDelivery']['subtaskKeys']
                            and f.get('id') != card['id']]
                if separate:
                    card['jiraDelivery']['conflictingCards'] = separate
            updates = changes_for(existing, card, run_id) if existing else {}
            entry = {'issueKey': card['jiraKey'], 'featureId': card['id'],
                     'action': 'update' if updates else ('skip' if existing else 'create'),
                     'fields': sorted(k for k in updates if k != 'jiraSyncHistory'),
                     'reason': 'Jira fields changed' if updates else ('Already synchronized' if existing else 'New Jira issue')}
            if card.get('jiraDelivery'):
                entry['delivery'] = card['jiraDelivery']
                if card['jiraDelivery'].get('worktreeMismatch'):
                    entry['reason'] = 'Legacy Story worktree differs from its Epic; migrate preserved work before dispatch'
                elif card['jiraDelivery'].get('conflictingCards'):
                    entry['reason'] = 'Existing subtask cards require manual scope reconciliation; no automatic dispatch'
                elif card['jiraDelivery']['requiresDecision']:
                    entry['reason'] = 'Waiting for Jira decomposition or explicit human approval'
            change_index = len(changes)
            changes.append(entry)
            card_mode = monitor.issue_mode(detail, config)
            dispatch_mode = card_mode[0] if card_mode else mode
            plans.append({'card': card, 'existing': existing, 'updates': updates,
                          'identity': ident, 'startMode': dispatch_mode, 'changeIndex': change_index,
                          'originalId': original_id})
    ids = {entry['originalId']: entry['card']['id'] for entry in plans}
    for entry in plans:
        entry['card']['dependencies'] = [ids.get(key, key) for key in entry['card'].get('dependencies', [])]
    # Report possible dispatches in preview using exactly the same admission rules.
    running = api.call('auto-mode/status', {}).get('runningFeatures', [])
    active_branches = {f.get('branchName') for f in features if f.get('id') in running}
    count = 0
    for entry in plans:
        existing = entry['existing']
        job = state.get('jobs', {}).get(entry['card']['jiraKey'], {})
        if (config.get('autoStart') and entry['startMode'] == 'auto'
                and not entry['card'].get('jiraDelivery', {}).get('requiresDecision')
                and not entry['card'].get('jiraDelivery', {}).get('conflictingCards')
                and not entry['card'].get('jiraDelivery', {}).get('worktreeMismatch')
                and not job.get('dispatchClaim')
                and job.get('status') not in ('running', 'dispatching', 'preparing', 'blocked', 'development_reported', 'mr_reported', 'needs_input')
                and (not existing or (existing.get('status') == 'backlog'
                                     and not existing.get('providerSessionId') and not existing.get('startedAt')))
                and all(any(f.get('id') == dependency and not f.get('archive') and f.get('status') in ('verified', 'completed')
                            for f in features) for dependency in entry['card'].get('dependencies', []))
                and entry['card']['branchName'] not in active_branches
                and len(running) + count < config.get('maxDispatchPerRun', 1)):
            entry['dispatch'] = True
            active_branches.add(entry['card']['branchName'])
            count += 1
            changes.append({'issueKey': entry['card']['jiraKey'], 'featureId': entry['card']['id'],
                            'action': 'dispatch', 'reason': 'Auto-start label and execution capacity available',
                            'delivery': entry['card'].get('jiraDelivery')})
    return plans, changes


def apply_plan(config, api, state, state_path, entries, run_id):
    for entry in entries:
        card, existing = entry['card'], entry['existing']
        # Re-read immediately before mutation: preview/read planning may have taken minutes.
        latest = next((f for f in api.call('features/list', {'projectPath': config['projectPath']}).get('features', [])
                       if f.get('id') == card['id']), None)
        if latest:
            if latest.get('archive') or latest.get('supersededBy') or latest.get('consolidationPlanId'):
                continue
            existing = latest
            entry['updates'] = changes_for(latest, card, run_id)
        job = state.setdefault('jobs', {}).setdefault(card['jiraKey'], {})
        job.update(featureId=card['id'], worktree=card['worktree'], branch=card['branchName'],
                   identity=entry['identity'], issueId=card['jiraIssueId'])
        state.setdefault('identities', {})[entry['identity']] = card['id']
        monitor.save(state_path, state)
        if not existing:
            monitor.ensure_worktree_for_branch(config, card['branchName'], card['worktree'])
            feature = {k: v for k, v in card.items()
                       if k not in ('contextMarkdown', 'mode', 'worktree', 'storyJiraKey')}
            feature['jiraSyncHistory'] = [{
                'runId': run_id, 'at': monitor.now(), 'actor': 'jira-sync', 'action': 'create',
                'fields': list(METADATA_FIELDS), 'reason': 'Imported Jira issue',
            }]
            # Deterministic feature id makes a retry after an uncertain create safe.
            api.call('features/create', {'projectPath': config['projectPath'], 'feature': feature})
            job['status'] = 'ready'
        elif entry['updates']:
            api.call('features/update', {'projectPath': config['projectPath'],
                                        'featureId': card['id'], 'updates': entry['updates']})
        if not existing or entry['updates']:
            context = Path(card['worktree']) / card['jiraContext']['path']
            if Path(card['worktree']).is_dir():
                context.parent.mkdir(parents=True, exist_ok=True)
                context.write_text(card['contextMarkdown'])
        if entry.get('dispatch'):
            if card.get('jiraDelivery', {}).get('worktreeMismatch'):
                continue
            running = api.call('auto-mode/status', {}).get('runningFeatures', [])
            if (len(running) >= config.get('maxDispatchPerRun', 1)
                    or (existing and (existing.get('status') != 'backlog'
                                      or existing.get('providerSessionId') or existing.get('startedAt')))):
                continue
            # Claim before the HTTP call. Timeout/crash is uncertain, never blindly replay.
            job.update(status='dispatching', dispatchClaim=run_id, dispatchedAt=monitor.now())
            monitor.save(state_path, state)
            try:
                api.call('features/update', {'projectPath': config['projectPath'],
                                             'featureId': card['id'],
                                             'updates': {'jiraDispatchRunId': run_id}})
                api.call('auto-mode/run-feature', {'projectPath': config['projectPath'],
                                                  'featureId': card['id'], 'useWorktrees': True})
                job['status'] = 'running'
            except Exception:
                job.update(status='blocked', error='Dispatch outcome uncertain; inspect task before retry')
                monitor.save(state_path, state)
                raise
        monitor.save(state_path, state)


def run(request):
    config = request['config']
    if request['mode'] == 'migration':
        legacy_dir = Path(request['legacyDir'])
        state = json.loads((legacy_dir / 'state.json').read_text()) if (legacy_dir / 'state.json').exists() else {'jobs': {}}
        target = Path(request['statePath'])
        backup = target.parent / 'legacy-backup.json'
        if not backup.exists():
            monitor.save(backup, {'config': config, 'state': state})
            backup.chmod(0o600)
        monitor.save(target, state)
        target.chmod(0o600)
        monitor.save(legacy_dir / 'managed-by-automaker.json',
                     {'projectPath': config['projectPath'], 'migratedAt': monitor.now()})
        return {'changes': [], 'message': 'Legacy snapshot and dispatch markers migrated under the shared lock'}
    # One CLI login belongs to one Jira site. Do not claim another site's identity.
    cli_config = Path(os.environ.get('JIRA_CONFIG_FILE', str(Path.home() / '.config/.jira/.config.yml')))
    import re
    server = re.search(r'^server:\s*[\'"]?([^\'"\s]+)', cli_config.read_text(), re.MULTILINE)
    if not server or server.group(1).rstrip('/') != config['jiraUrl'].rstrip('/'):
        raise ValueError('Configured Jira URL does not match the server-side Jira CLI login')
    # One tick is a consistent requirements snapshot, without repeated CLI requests per ancestor.
    detail_cache = {}
    original_detail = monitor.issue_detail
    def cached_detail(c, key):
        if key not in detail_cache:
            detail_cache[key] = original_detail(c, key)
        return detail_cache[key]
    monitor.issue_detail = cached_detail
    mode = request['mode']
    if mode == 'test':
        monitor.checked([config['jiraCommand'], 'serverinfo'], timeout=20)
        monitor.search(config)
        return {'message': 'Jira CLI authentication succeeded', 'changes': []}
    state_path = Path(request['statePath'])
    state = json.loads(state_path.read_text()) if state_path.exists() else {'jobs': {}}
    api = ManagedAPI(config, state, state_path)
    entries, changes = build_plan(config, api, state, request['runId'])
    if mode == 'sync':
        apply_plan(config, api, state, state_path, entries, request['runId'])
        decomposition = monitor.apply_decomposition_requests(config, state, api)
        if decomposition.get('created'):
            changes.append({'action': 'decomposition', 'reason': 'Processed human-approved Jira splits', 'result': decomposition})
        # External writeback remains a separately configured policy. Only fresh,
        # run-scoped receipts can supply outcomes; never modify task status here.
        active = set(api.call('auto-mode/status', {}).get('runningFeatures', []))
        current_jobs = {}
        for key, job in state.get('jobs', {}).items():
            if not job.get('worktree') or not job.get('featureId'):
                continue
            try:
                feature = api.call('features/get', {'projectPath': config['projectPath'],
                                                   'featureId': job['featureId']}).get('feature') or {}
            except monitor.urllib.error.HTTPError as error:
                if error.code == 404:
                    continue
                raise
            current_run = feature.get('executionRunId')
            if feature.get('archive') or feature.get('supersededBy') or feature.get('consolidationPlanId'):
                continue
            if not current_run:
                continue
            if job.get('featureId') in active:
                if job.get('dispatchClaim') == current_run:
                    job['status'] = 'running'
                    # No prior-run receipt may accompany this run's milestone.
                    if (job.get('result') or {}).get('runId') != current_run:
                        job.pop('result', None)
                    current_jobs[key] = job
                continue
            receipt_path = monitor.receipt_path_for(job['worktree'], job['featureId'])
            if not receipt_path.exists():
                continue
            receipt = json.loads(receipt_path.read_text())
            if receipt.get('runId') != current_run:
                continue
            job['result'] = receipt
            if receipt.get('outcome') == 'needs_input':
                if job.get('receiptRunId') != current_run:
                    for field in ('humanAnswerClaim', 'questionMarker', 'questionDigest',
                                  'questionCommentId', 'questionCreated'):
                        job.pop(field, None)
                job['status'] = 'needs_input'
            job['receiptRunId'] = current_run
            if monitor.validate_receipt(receipt, key, job['worktree'], config['gitlabHost']):
                job['status'] = ('development_reported'
                                 if receipt.get('outcome') == 'development_complete'
                                 else 'mr_reported')
            elif receipt.get('outcome') != 'needs_input':
                job['status'] = 'blocked'
            current_jobs[key] = job
        # Only jobs proven to belong to the current execution may generate external writes.
        write_state = dict(state, jobs=current_jobs)
        if config.get('jiraProgressMode') != 'off':
            monitor.sync_jira_progress(config, write_state)
        # Human-input comments are supported only for current run-scoped needs_input.
        if config.get('jiraHumanInputEnabled'):
            # Persist the complete state even while the legacy helper iterates a filtered view.
            original_save = monitor.save
            monitor.save = lambda file, value: original_save(file, state if value is write_state else value)
            try:
                monitor.sync_human_input(config, write_state, state_path, api)
            finally:
                monitor.save = original_save
        for key, job in current_jobs.items():
            if job.get('jiraSyncError') or job.get('humanInputError'):
                changes.append({'issueKey': key, 'featureId': job.get('featureId'),
                                'action': 'blocked',
                                'reason': 'Jira comment synchronization failed or could not be confirmed; inspect authentication and comment history'})
        state['lastPoll'] = monitor.now()
        monitor.save(state_path, state)
    return {'changes': changes, 'message': f'{len(entries)} cards examined; {mode}'}


def main():
    request = json.load(sys.stdin)
    lock_path = Path(request['lockPath'])
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another Jira sync owns this configuration')
        # Legacy importer prints informational output. Protocol stdout is JSON only.
        with contextlib.redirect_stdout(io.StringIO()):
            result = run(request)
        print(json.dumps({'success': True, **result}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not include command output, auth headers or expanded config in the response.
        message = ('Jira CLI site differs from configured URL' if isinstance(error, ValueError) and 'CLI login' in str(error)
                   else 'Another Jira operation holds the lock; retry after it finishes' if 'owns this configuration' in str(error)
                   else f'{type(error).__name__}: Jira operation failed; check CLI authentication, JQL and project access')
        print(json.dumps({'success': False, 'error': message}))
        sys.exit(1)
