"""Scan admission and import-history rules for the Jira monitor.

The board imports Jira work at the root of a Jira hierarchy only, and never
deeper than one level below it:

- a root issue is the import unit;
- a Jira subtask is never imported on its own: its parent is imported and the
  subtask becomes scope inside that parent's card;
- when the label sits on a subtask while its parent is unlabelled, nothing is
  imported and the situation is recorded for a human, because importing the root
  would silently widen the work and importing the subtask would create a
  non-root card.

The module avoids Jira CLI calls: it takes already-fetched field dictionaries so
the rules stay unit-testable.
"""

import json
import re
from pathlib import Path

# Outcomes recorded in the import history.
IMPORTED = 'imported'
SKIPPED_SUBTASK = 'skipped_subtask'
LABEL_ON_SUBTASK_ONLY = 'label_on_subtask_only'
NO_ROOT_LABEL = 'no_root_label'

_PARENT_KEY_PATTERN = re.compile(r'^[A-Z][A-Z0-9]*-\d+$')


def parent_key_of(fields):
    """Jira parent key of an issue, or None for a root issue."""
    parent = (fields or {}).get('parent')
    if isinstance(parent, str):
        value = parent.strip().upper()
    elif isinstance(parent, dict):
        value = str(parent.get('key') or '').strip().upper()
    else:
        return None
    return value if _PARENT_KEY_PATTERN.match(value) else None


def is_subtask_fields(fields):
    """True when the issue is a Jira subtask (its type flags ``subtask``)."""
    issue_type = (fields or {}).get('issueType') or (fields or {}).get('issuetype') or {}
    return bool(issue_type.get('subtask'))


def has_monitored_label(fields, config):
    """Whether the issue carries a label the monitor is configured to act on."""
    labels = [str(label).strip() for label in ((fields or {}).get('labels') or [])]
    rules = config.get('jiraLabels') or {}
    allowed = set(rules.get('autoStart') or []) | set(rules.get('manualStart') or [])
    if not allowed and config.get('jiraLabel'):
        allowed = {config['jiraLabel']}
    return bool(set(labels) & allowed)


def classify_scan_hit(issue, config, parent_issue=None):
    """Decide what one labelled scan hit means.

    Returns ``(admission, reason)`` where admission is one of ``IMPORTED``,
    ``SKIPPED_SUBTASK``, ``LABEL_ON_SUBTASK_ONLY`` or ``NO_ROOT_LABEL``.
    """
    fields = issue.get('fields', {}) or {}
    key = str(issue.get('key') or '').strip().upper()
    if not is_subtask_fields(fields):
        if has_monitored_label(fields, config):
            return IMPORTED, f'{key} is a root issue'
        return NO_ROOT_LABEL, f'{key} is a root issue without a monitored label'

    parent = parent_issue or {}
    parent_fields = parent.get('fields', {}) or {}
    parent_key = parent_key_of(fields) or str(parent.get('key') or '').strip().upper()
    if parent and has_monitored_label(parent_fields, config):
        return (SKIPPED_SUBTASK,
                f'{key} is a subtask of {parent_key}; importing {parent_key} instead')
    return (LABEL_ON_SUBTASK_ONLY,
            f'label is on subtask {key} but its parent '
            f'{parent_key or "<unknown>"} is unlabelled')


def merge_descendant_context(parent_detail, child_details):
    """Fold deeper Jira levels into the parent's requirement text.

    Splits stop one level below the root, so anything found deeper is appended
    to its parent's description instead of becoming its own card.
    """
    parent_fields = (parent_detail or {}).get('fields') or {}
    parts = [str(parent_fields.get('summary') or '').strip(),
             str(parent_fields.get('description') or '').strip()]
    for child in child_details or []:
        fields = (child or {}).get('fields') or {}
        key = str((child or {}).get('key') or '').strip()
        summary = str(fields.get('summary') or '').strip()
        description = str(fields.get('description') or '').strip()
        label = f'{key}: {summary}' if key else summary
        if description:
            label = f'{label}\n{description}' if label else description
        if label.strip():
            parts.append(label.strip())
    return '\n\n'.join(part for part in parts if part)


def history_entry(key, outcome, reason, root_key=None, subtask_keys=None, extra=None):
    """One import-history record."""
    entry = {'key': str(key or '').upper(), 'outcome': outcome, 'reason': reason}
    if root_key:
        entry['rootKey'] = str(root_key).upper()
    if subtask_keys:
        entry['subtaskKeys'] = [str(item).upper() for item in subtask_keys]
    if extra:
        entry.update(extra)
    return entry


def append_import_history(path, entries):
    """Append import-history records as JSON lines (append-only)."""
    if not entries:
        return 0
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('a', encoding='utf-8') as handle:
        for entry in entries:
            handle.write(json.dumps(entry, ensure_ascii=False) + '\n')
    return len(entries)
