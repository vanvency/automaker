#!/usr/bin/env python3
"""Read Jira closure choices or apply one explicitly selected transition. JSON stdin/stdout."""
import base64
import json
import netrc
import os
from pathlib import Path
import re
import sys
import socket
import ssl
import time
import urllib.error
import urllib.request
import urllib.parse


def completion_choices(transitions, issue_fields, include_fields=False):
    choices = []
    for transition in transitions:
        if transition.get('to', {}).get('statusCategory', {}).get('key') != 'done':
            continue
        required = {key: meta for key, meta in transition.get('fields', {}).items()
                    if meta.get('required')}
        if not include_fields and any(not meta.get('hasDefaultValue') for meta in required.values()):
            continue
        choice = {'id': transition['id'], 'name': transition['name'], 'target': transition['to']['name']}
        if include_fields:
            fields = []
            for key, meta in required.items():
                schema = meta.get('schema', {})
                allowed = [{'id': str(v['id']), 'name': str(v.get('name') or v.get('value') or v['id'])}
                           for v in meta.get('allowedValues', []) if isinstance(v, dict) and 'id' in v]
                multiple = schema.get('type') == 'array'
                current = issue_fields.get(key) or meta.get('defaultValue')
                values = current if isinstance(current, list) else [current] if current else []
                ids = [str(v['id']) for v in values if isinstance(v, dict) and 'id' in v]
                allowed_ids = {v['id'] for v in allowed}
                fields.append({'key': key, 'name': meta.get('name', key), 'multiple': multiple,
                               'allowedValues': allowed, 'value': [v for v in ids if v in allowed_ids],
                               'supported': bool(allowed) and (schema.get('type') in ('resolution', 'option', 'version')
                                   or multiple and schema.get('items') in ('version', 'option'))})
            choice['fields'] = fields
        choices.append(choice)
    return choices


def transition_fields(choice, supplied):
    if not isinstance(supplied, dict):
        raise ValueError('Invalid Jira completion fields')
    fields = choice.get('fields', [])
    if set(supplied) - {f['key'] for f in fields}:
        raise ValueError('Unknown Jira completion field')
    result = {}
    for field in fields:
        if not field['supported']:
            raise ValueError('Complete required field in Jira: ' + field['name'])
        ids = supplied.get(field['key'], [])
        allowed = {v['id'] for v in field['allowedValues']}
        if (not isinstance(ids, list) or not ids or any(not isinstance(v, str) or v not in allowed for v in ids)
                or len(set(ids)) != len(ids) or not field['multiple'] and len(ids) != 1):
            raise ValueError('Select a valid Jira value for ' + field['name'])
        values = [{'id': value} for value in ids]
        result[field['key']] = values if field['multiple'] else values[0]
    return result


def jira_error_message(error):
    # Do not echo URLs, headers or response bodies: they can contain credentials.
    if isinstance(error, urllib.error.HTTPError):
        return f'Jira returned HTTP {error.code}; check authentication, permissions or Jira availability'
    if isinstance(error, FileNotFoundError):
        return 'Jira CLI configuration file is missing; configure JIRA_CONFIG_FILE'
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return 'Jira request timed out'
    if isinstance(reason, socket.gaierror):
        return 'Jira hostname could not be resolved'
    if isinstance(reason, ssl.SSLError):
        return 'Jira TLS certificate or handshake failed'
    if isinstance(error, urllib.error.URLError):
        return 'Could not connect to Jira; check server connectivity'
    if isinstance(error, (KeyError, TypeError, json.JSONDecodeError)):
        return 'Jira returned an unexpected response format'
    return str(error) if isinstance(error, ValueError) else f'Jira request failed ({type(error).__name__})'


def request_json(opener, request, read_attempts=3):
    # Only GET is retryable. A timed-out transition might already have succeeded.
    attempts = read_attempts if request.get_method() == 'GET' else 1
    for attempt in range(attempts):
        try:
            with opener.open(request, timeout=15) as response:
                content = response.read()
                return json.loads(content) if content else {}
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            transient = not isinstance(error, urllib.error.HTTPError) or error.code in (429, 502, 503, 504)
            if attempt + 1 == attempts or not transient:
                raise
            time.sleep(0.3 * (attempt + 1))


def close_and_confirm(api, payload):
    write_error = None
    try:
        api('/transitions', payload)
    except Exception as error:
        write_error = error
    # Even if POST's reply was lost, a read can prove it succeeded. Never retry POST.
    try:
        fields = api('?fields=status,updated,summary')['fields']
        if fields['status'].get('statusCategory', {}).get('key') == 'done':
            return fields
    except Exception as error:
        raise ValueError('Jira closure was submitted but its final state could not be confirmed: '
                         + jira_error_message(error) + '. Refresh Complete to reconcile; the transition will not be blindly repeated.') from error
    if write_error:
        raise ValueError('Jira closure is not confirmed: ' + jira_error_message(write_error)
                         + '. Refresh Complete before retrying.') from write_error
    raise ValueError('Jira transition returned, but the issue is not Closed/Done. Refresh Complete before retrying.')


def main():
    request = json.load(sys.stdin)
    key = request.get('key', '')
    if not re.fullmatch(r'[A-Z][A-Z0-9_]*-\d+', key):
        raise ValueError('Invalid Jira key')
    config = Path(os.environ.get('JIRA_CONFIG_FILE', str(Path.home() / '.config/.jira/.config.yml'))).read_text()
    match = re.search(r'^server:\s*[\'"]?([^\'"\s]+)', config, re.MULTILINE)
    server = (match.group(1) if match else '').rstrip('/')
    if server != request['server'].rstrip('/'):
        raise ValueError('Jira site does not match the server CLI login')
    url = urllib.parse.urlparse(server)
    if url.scheme not in ('http', 'https') or url.username or url.password:
        raise ValueError('Invalid Jira URL')
    token = os.environ.get('JIRA_API_TOKEN')
    auth = None
    if token:
        if os.environ.get('JIRA_AUTH_TYPE') == 'basic':
            user = os.environ.get('JIRA_USER')
            if not user:
                raise ValueError('JIRA_USER is required for basic authentication')
            auth = 'Basic ' + base64.b64encode(f'{user}:{token}'.encode()).decode()
        else:
            auth = 'Bearer ' + token
    else:
        try:
            credentials = netrc.netrc().authenticators(url.hostname)
        except (FileNotFoundError, netrc.NetrcParseError):
            credentials = None
        if credentials:
            auth = 'Basic ' + base64.b64encode(f'{credentials[0]}:{credentials[2]}'.encode()).decode()
    if not auth:
        raise ValueError('No Jira REST credentials; configure JIRA_API_TOKEN or host credentials in netrc')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError('Jira redirected; check configured site')
    opener = urllib.request.build_opener(NoRedirect)

    def api(suffix='', body=None):
        req = urllib.request.Request(
            server + '/rest/api/2/issue/' + key + suffix,
            headers={'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'application/json'},
            data=json.dumps(body).encode() if body is not None else None)
        return request_json(opener, req)

    issue = api('?fields=status,updated,summary')
    fields = issue['fields']
    status = fields['status']
    done = status.get('statusCategory', {}).get('key') == 'done'
    transitions = api('/transitions?expand=transitions.fields').get('transitions', []) if not done else []
    include_fields = request.get('includeFields') == 'true'
    if include_fields and transitions:
        required_keys = {key for t in transitions for key, meta in t.get('fields', {}).items() if meta.get('required')}
        if required_keys:
            extra = api('?fields=' + urllib.parse.quote(','.join(sorted(required_keys))))
            fields.update(extra.get('fields', {}))
    choices = completion_choices(transitions, fields, include_fields)
    if request['action'] == 'close':
        if not done:
            if fields['updated'] != request['expectedUpdated']:
                raise ValueError('Jira changed since preview; generate a new plan')
            transition = next((t for t in choices if t['id'] == request['transitionId']), None)
            if not transition:
                raise ValueError('Selected terminal transition is no longer available or needs extra fields')
            payload = {'transition': {'id': transition['id']}}
            if include_fields:
                payload['fields'] = transition_fields(transition, json.loads(request.get('fields', '{}')))
            fields = close_and_confirm(api, payload)
            status = fields['status']
            done = status.get('statusCategory', {}).get('key') == 'done'
            if not done:
                raise ValueError('Jira transition could not be verified')
    elif request['action'] != 'inspect':
        raise ValueError('Invalid Jira action')
    return {'key': key, 'url': server + '/browse/' + key, 'status': status['name'],
            'updated': fields['updated'], 'done': done, 'transitions': choices}


if __name__ == '__main__':
    try:
        print(json.dumps({'success': True, 'result': main()}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'success': False, 'error': jira_error_message(error)}))
