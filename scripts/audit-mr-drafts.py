#!/usr/bin/env python3
"""Force every Automaker-managed merge request into draft until the board verifies it.

Why this exists
---------------
gitblue.transwarp.io runs GitLab 15.0.2, which

  * rejects the documented push options with ``remote: State is invalid``
    (``git push -o merge_request.create -o merge_request.draft ...``), and
  * rejects the REST ``draft`` parameter with HTTP 400,

so a draft MR can only be expressed as the title prefix ``Draft: ``. Agents that
fell back to the REST API (or renamed an MR through it to add the Jira key)
produced "ready" MRs, which violates the repository rule that every agent-created
MR stays a draft.

What it does
------------
For every open MR whose source branch is an Automaker feature branch
(``<type>/<key>`` such as ``task/aip-123``, or the legacy
``jira/aip-<key>-<dodo|kaka>`` form) it looks up the features on that branch.
Unless *all* of them are ``completed``/``verified`` on the board, the MR title
gets the ``Draft: `` prefix (idempotent). MRs on branches outside the Automaker
board are reported but never touched.

Usage:
    python3 scripts/audit-mr-drafts.py [--config ...] [--apply]
"""

import argparse
import datetime
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Branch prefixes the Jira monitor dispatches work on. Keep in sync with
# BRANCH_PREFIX_RULES in jira-monitor.py: the issue type maps to one of these and
# the config's `branchPrefixes` can override it (that override is not visible
# here, which is why the board lookup below is authoritative).
AUTOMAKER_BRANCH_PREFIXES = ("jira", "epic", "story", "feat", "impr", "bugfix", "task")

DONE_STATUSES = ("completed", "verified")


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def automaker_branch_pattern(project_key=None):
    """Regex for the Jira branches the monitor dispatches work on.

    ``<type-prefix>/<jira key>[-<label>]``: ``task/aip-123`` (current naming) and
    ``jira/aip-123-kaka`` (legacy, from before branches were named by work type).
    """
    prefixes = "|".join(AUTOMAKER_BRANCH_PREFIXES)
    project = re.escape(project_key.lower()) if project_key else r"[a-z0-9]+"
    return re.compile(rf"^(?:{prefixes})/(?:{project})-\d+(?:-[a-z0-9._-]+)?$", re.IGNORECASE)


AUTOMAKER_BRANCH = automaker_branch_pattern()


def is_automaker_branch(branch, known_branches=(), project_key=None):
    """Whether an MR source branch carries Automaker work.

    The board lookup (``known_branches``) is authoritative: a branch with board
    features is agent work even when its name predates the current
    ``<type>/<key>`` convention or uses a configured prefix override. The name
    pattern is the fallback for MRs whose features were removed from the board.
    """
    if not branch:
        return False
    if branch in known_branches:
        return True
    pattern = automaker_branch_pattern(project_key) if project_key else AUTOMAKER_BRANCH
    return bool(pattern.match(branch))


def project_leaf(path):
    """Display only the repository name; directory prefixes are git-internal."""
    return str(path or "").rstrip("/").rsplit("/", 1)[-1]


class Gitlab:
    def __init__(self, host, token):
        self.host = host.rstrip("/")
        self.token = token

    def call(self, path, method="GET", data=None):
        url = f"{self.host}/api/v4/{path}"
        request = urllib.request.Request(
            url, headers={"PRIVATE-TOKEN": self.token}, method=method
        )
        if data is not None:
            request.data = urllib.parse.urlencode(data).encode()
            request.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise RuntimeError(
                f"{method} {path} -> HTTP {error.code} "
                f"{error.read().decode('utf-8', 'replace')[:200]}"
            )

    def open_merge_requests(self):
        results, page = [], 1
        while True:
            batch = self.call(
                f"merge_requests?scope=all&state=opened&per_page=100&page={page}"
                "&order_by=updated_at"
            )
            results.extend(batch)
            if len(batch) < 100 or page >= 10:
                return results
            page += 1

    def project_path(self, web_url):
        """Extract the project path and MR iid from a GitLab web URL."""
        path = urllib.parse.urlsplit(web_url).path.lstrip("/")
        if "/-/merge_requests/" in path:
            project, iid = path.split("/-/merge_requests/")
            return project, int(iid.split("/")[0])
        return None, None


class Automaker:
    def __init__(self, url, key, project):
        self.url = url.rstrip("/")
        self.key = key
        self.project = project

    def call(self, route, body):
        request = urllib.request.Request(
            f"{self.url}/api/{route}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-API-Key": self.key},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))

    def features(self):
        return self.call("features/list", {"projectPath": self.project})["features"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/workspace/automaker/data/jira-monitor/config.json")
    parser.add_argument("--token-file", default="/root/gitlab-token")
    parser.add_argument("--report", default="/workspace/automaker/data/run-all/mr-draft-audit.json")
    parser.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text())
    gitlab = Gitlab(config.get("jiraUrl") and "https://gitblue.transwarp.io" or
                    "https://" + config["gitlabHost"], Path(args.token_file).read_text().strip())
    automaker = Automaker(
        config["automakerUrl"], Path(config["apiKeyFile"]).read_text().strip(), config["projectPath"]
    )

    by_branch = {}
    for feature in automaker.features():
        branch = feature.get("branchName")
        if branch:
            by_branch.setdefault(branch, []).append(feature)

    records, untouched, failures = [], [], []
    for mr in gitlab.open_merge_requests():
        branch = mr.get("source_branch") or ""
        if not is_automaker_branch(branch, by_branch, config.get("jiraProject")):
            untouched.append(
                {
                    "iid": mr["iid"],
                    "branch": branch,
                    "webUrl": mr["web_url"],
                    "reason": "非 automaker 分支（名称不匹配且不在任务板上），未改动",
                }
            )
            continue
        features = by_branch.get(branch, [])
        pending = [f for f in features if f.get("status") not in DONE_STATUSES]
        confirmed = bool(features) and not pending
        record = {
            "iid": mr["iid"],
            "webUrl": mr["web_url"],
            "project": project_leaf(
                mr["web_url"].split("/-/merge_requests/")[0].split("gitblue.transwarp.io/")[-1]
            ),
            "branch": branch,
            "wasDraft": bool(mr.get("draft")),
            "featureCount": len(features),
            "unconfirmedFeatures": [
                {"id": f["id"], "status": f.get("status")} for f in pending[:6]
            ],
            "boardConfirmedComplete": confirmed,
        }
        if not confirmed and not mr.get("draft"):
            project_path, iid = gitlab.project_path(mr["web_url"])
            if not args.apply:
                record["action"] = "would-draft"
            else:
                try:
                    updated = gitlab.call(
                        f"projects/{urllib.parse.quote(project_path, safe='')}/merge_requests/{iid}",
                        "PUT",
                        {"title": "Draft: " + mr["title"]},
                    )
                    record["action"] = "drafted"
                    record["draftAfter"] = bool(updated.get("draft"))
                    record["titleAfter"] = updated.get("title")
                except Exception as error:  # keep auditing the rest
                    record["action"] = "failed"
                    record["error"] = str(error)
                    failures.append({"iid": iid, "error": str(error)})
        elif not confirmed:
            record["action"] = "already-draft"
        else:
            record["action"] = "leave-ready (board verified)"
        records.append(record)

    report = {
        "generatedAt": now(),
        "mode": "apply" if args.apply else "dry-run",
        "rootCause": (
            "GitLab 15.0.2 rejects merge_request.create push options (State is invalid) and "
            "rejects the REST draft parameter (HTTP 400); draft exists only as the 'Draft: ' "
            "title prefix, so API-created MRs are created ready."
        ),
        "summary": {
            "automakerMrs": len(records),
            "drafted": len([r for r in records if r["action"] == "drafted"]),
            "wouldDraft": len([r for r in records if r["action"] == "would-draft"]),
            "alreadyDraft": len([r for r in records if r["action"] == "already-draft"]),
            "leftReady": len([r for r in records if r["action"].startswith("leave-ready")]),
            "failures": len(failures),
            "untouchedNonAutomaker": len(untouched),
        },
        "mergeRequests": records,
        "untouched": untouched,
    }
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    for record in records:
        if record["action"] in ("drafted", "would-draft", "failed"):
            print(f"  !{record['iid']:>4} {record['action']:12} {record['branch']} "
                  f"({len(record['unconfirmedFeatures'])} 未确认)")


if __name__ == "__main__":
    main()
