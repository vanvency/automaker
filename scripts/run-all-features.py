#!/usr/bin/env python3
"""Drive every pending Automaker feature of a project in dependency order.

The Jira monitor dispatches one issue at a time; this runner does the same for the
whole board: it walks the backlog in dependency order, runs each feature through
Automaker, then verifies the delivery locally before moving on.

Per feature it performs:

1. dispatch    POST /api/auto-mode/run-feature (waits for an idle Automaker first)
2. wait        poll the feature until it leaves the running state
3. verify      delivery receipt, test log, MR URLs, commit evidence in the worktree
4. parity      for frontend deliveries: screenshot the vibe-design prototype
               (port 3001) routes that match the feature so the operator can
               compare the prototype with the implementation

State lives in ``data/run-all/``: ``queue.json`` (plan), ``progress.jsonl``
(append-only results), ``RUN_REPORT.md`` (summary) and ``parity/`` (screenshots).
The runner is resumable: features already recorded as verified are skipped.
"""

import argparse
import datetime
import importlib.util
import json
import math
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

# "in_progress" is included so a restarted runner adopts whatever is already
# executing instead of starting a second feature on the same worktree.
STARTABLE_STATUSES = ("backlog", "ready", "interrupted", "in_progress")
FINISHED_STATUSES = ("completed", "verified")
TERMINAL_STATUSES = ("completed", "verified", "waiting_approval")
# Display uses only the leaf project name (e.g. "saas-frontend"); the repository
# path is kept separately for git operations.
UI_SUBPROJECTS = ("frontend/saas-frontend",)
UI_PROJECT_NAMES = ("saas-frontend",)


def project_leaf(name):
    """Last path segment of a repository path, for display only."""
    return str(name or "").rstrip("/").rsplit("/", 1)[-1]


# ── helpers ──────────────────────────────────────────────────────────────────


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def log(message):
    line = f"[{now()}] {message}"
    print(line, flush=True)
    with open(LOGFILE, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def load_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def parse_ts(value):
    """Parse an RFC3339 timestamp; returns None when absent or malformed."""
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        parsed = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def monitor_module():
    """Import the Jira monitor to reuse its receipt validation rules."""
    path = SCRIPT_DIR / "jira-monitor.py"
    spec = importlib.util.spec_from_file_location("jira_monitor", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Api:
    def __init__(self, url, key):
        self.url = url.rstrip("/")
        self.key = key
        self.restarts = 0

    def healthy(self, timeout=5):
        try:
            with urllib.request.urlopen(f"{self.url}/api/health", timeout=timeout) as response:
                return response.status == 200
        except Exception:
            return False

    def wait_healthy(self, timeout=1800, interval=15):
        """Wait out an Automaker restart instead of treating it as a failure."""
        deadline = time.time() + timeout
        waited = False
        while time.time() < deadline:
            if self.healthy():
                if waited:
                    self.restarts += 1
                    log("Automaker API is back online; resuming")
                return True
            if not waited:
                log("Automaker API is unreachable (server restarting?); waiting")
                waited = True
            time.sleep(interval)
        return False

    def call(self, route, body=None, timeout=60, retries=3):
        attempt = 0
        while True:
            try:
                return self._call(route, body, timeout)
            except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
                attempt += 1
                if attempt > retries or not self.wait_healthy(timeout=1800):
                    raise
                log(f"{route} failed ({error}); retrying after server recovery")

    def _call(self, route, body=None, timeout=60):
        request = urllib.request.Request(
            f"{self.url}/api/{route}",
            data=json.dumps(body or {}).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-API-Key": self.key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise RuntimeError(
                f"{route} failed: HTTP {error.code} {error.read().decode('utf-8', 'replace')[:300]}"
            )


def git(args, cwd, timeout=60):
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except Exception as error:  # pragma: no cover - defensive
        return 1, "", str(error)


def worktree_for_branch(project, branch):
    """Resolve the checkout for a branch from ``git worktree list``."""
    code, out, _ = git(["worktree", "list", "--porcelain"], project, 30)
    if code != 0:
        return None
    current = None
    for line in out.splitlines():
        if line.startswith("worktree "):
            current = line.split(" ", 1)[1].strip()
        elif line.startswith("branch ") and current:
            ref = line.split(" ", 1)[1].strip()
            if ref.replace("refs/heads/", "") == branch:
                return Path(current)
    return None


# ── planning ─────────────────────────────────────────────────────────────────


def order_features(features, statuses=STARTABLE_STATUSES, soft_statuses=("waiting_approval",)):
    """Stable topological order, oldest first inside the ready set.

    ``soft_statuses`` are treated as satisfied for scheduling because Automaker's
    own auto loop stops re-dispatching them, but they are reported separately so
    the operator still reviews the unverified dependency.
    """
    by_id = {feature["id"]: feature for feature in features}
    pending = [f for f in features if f.get("status") in statuses]
    ordered, blocked, soft_deps = [], {}, {}
    done = {
        f["id"]
        for f in features
        if f.get("status") in FINISHED_STATUSES or f.get("status") in soft_statuses
    }
    remaining = sorted(pending, key=lambda f: (f.get("createdAt") or "", f["id"]))
    while remaining:
        progressed = False
        for feature in list(remaining):
            deps = feature.get("dependencies") or []
            unmet = [
                dep
                for dep in deps
                if dep not in done
                or (by_id.get(dep, {}).get("status") in soft_statuses)
            ]
            hard_unmet = [
                dep
                for dep in unmet
                if by_id.get(dep) is None or by_id[dep].get("status") not in soft_statuses
            ]
            if hard_unmet:
                blocked[feature["id"]] = hard_unmet
                continue
            if unmet:
                soft_deps[feature["id"]] = unmet
            ordered.append(feature)
            done.add(feature["id"])
            remaining.remove(feature)
            blocked.pop(feature["id"], None)
            progressed = True
        if not progressed:
            for feature in remaining:
                blocked.setdefault(feature["id"], feature.get("dependencies") or ["<cycle>"])
            break
    return ordered, blocked, soft_deps


# ── execution ────────────────────────────────────────────────────────────────


def wait_for_idle(api, project, timeout=None, poll=15):
    """Wait until no feature is executing anywhere.

    The per-project status call answers for one worktree only, so the global
    status (no projectPath) is the reliable "is anything running" source.
    Waiting is unbounded by default: a single feature may legitimately run for
    hours, and this runner exists to keep the queue moving in order.
    """
    started = time.time()
    next_report = started + 300
    while timeout is None or time.time() - started < timeout:
        status = api.call("auto-mode/status", {})
        running = status.get("runningFeatures") or []
        if not running:
            return True
        if time.time() >= next_report:
            next_report = time.time() + 300
            log(
                f"board busy with {', '.join(running)} for "
                f"{int((time.time() - started) / 60)} min; waiting for an idle slot"
            )
        time.sleep(poll)
    return False


def feature_status(api, project, feature_id):
    return api.call("features/get", {"projectPath": project, "featureId": feature_id})["feature"]


def ensure_delivery_directive(api, project, monitor, feature, worktree):
    """Backfill the delivery contract on a legacy ``-child-N`` card.

    New splits carry their own Jira key and receive the contract from the Jira
    monitor prompt, so this only covers cards created by the retired automatic
    decomposition. The contract itself is shared with jira-monitor.py.
    Automaker rewrites feature.json from an in-memory copy on every status change,
    so a description patch done at any other time can be overwritten. Re-applying
    it immediately before dispatch is the only durable moment.
    """
    if "-child-" not in feature["id"]:
        return False
    live = feature_status(api, project, feature["id"])
    description = live.get("description") or ""
    if monitor.DELIVERY_MARKER in description:
        return False
    block = monitor.delivery_directive(
        feature.get("jiraKey") or "<issue key>",
        str(worktree),
        feature.get("branchName"),
        feature_id=feature["id"],
    )
    api.call(
        "features/update",
        {
            "projectPath": project,
            "featureId": feature["id"],
            "updates": {"description": description.rstrip() + "\n\n" + block},
        },
    )
    log(f"  injected delivery-receipt directive into {feature['id']}")
    return True


def run_one(api, project, feature, timeout, poll=20, max_attempts=2):
    """Dispatch a single feature and wait for it to settle. Returns final feature."""
    for attempt in range(1, max_attempts + 1):
        active = api.call("auto-mode/status", {})
        already_running = feature["id"] in set(active.get("runningFeatures") or [])
        if already_running:
            log(f"  {feature['id']} is already executing; waiting for it to settle")
        else:
            if not wait_for_idle(api, project):
                raise RuntimeError("Automaker stayed busy for an hour; another run owns the board")
            log(f"dispatch {feature['id']} (attempt {attempt}/{max_attempts})")
            api.call(
                "auto-mode/run-feature",
                {"projectPath": project, "featureId": feature["id"], "useWorktrees": True},
            )
        deadline = time.time() + timeout
        settled = 0
        while time.time() < deadline:
            time.sleep(poll)
            current = feature_status(api, project, feature["id"])
            status = current.get("status")
            if status in TERMINAL_STATUSES:
                log(f"  -> {feature['id']} settled as {status}")
                return current
            active = api.call("auto-mode/status", {})
            if feature["id"] not in set(active.get("runningFeatures") or []):
                settled += 1
                if settled >= 4 and status == "backlog":
                    log(f"  -> {feature['id']} fell back to backlog without running (attempt {attempt})")
                    break
                if settled >= 12:
                    log(f"  -> {feature['id']} stalled in {status}; retrying")
                    break
            else:
                settled = 0
        else:
            log(f"  -> {feature['id']} exceeded {timeout}s timeout")
    return feature_status(api, project, feature["id"])


# ── verification ─────────────────────────────────────────────────────────────


def changed_subprojects(worktree):
    """Subprojects carrying work in the feature worktree.

    Two sources are combined: submodules whose checked-out HEAD differs from the
    recorded gitlink (``git status``), and submodules moved by committed gitlink
    updates on the branch (root diff against origin/dev).
    """
    worktree = Path(worktree)
    names = set()
    code, out, _ = git(["status", "--porcelain", "--ignore-submodules=none"], worktree, 120)
    if code == 0:
        for line in out.splitlines():
            if len(line) > 3 and line[:2].strip():
                names.add(line[3:].strip().strip('"').split(" -> ")[-1])
    code, out, _ = git(["diff", "--name-only", "origin/dev", "HEAD"], worktree, 120)
    if code == 0 and out:
        names.update(line.strip() for line in out.splitlines() if line.strip())
    changed = []
    for name in sorted(names):
        path = worktree / name
        if not (path / ".git").exists():
            continue
        code, out, _ = git(["log", "--oneline", "--no-decorate", "origin/dev..HEAD"], path, 60)
        if code != 0 or not out:
            code, out, _ = git(["log", "--oneline", "--no-decorate", "-5"], path, 60)
        if code == 0 and out:
            changed.append(
                {"name": project_leaf(name), "path": name, "commits": out.splitlines()}
            )
    return changed


def git_evidence(worktree, branch):
    """Commit and remote-branch evidence for a feature whose branch is pushed."""
    env = {"GIT_SSH_COMMAND": "ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=15"}
    evidence = {"branch": branch, "remoteBranch": False, "subprojects": []}
    if not branch:
        return evidence
    for sub in changed_subprojects(worktree):
        path = Path(worktree) / sub["path"]
        code, out, _ = git(["log", "--oneline", "--no-decorate", "origin/dev..HEAD"], path, 60)
        ahead = out.splitlines() if code == 0 else []
        remote = subprocess.run(
            ["git", "ls-remote", "--heads", "origin", branch],
            cwd=str(path),
            capture_output=True,
            text=True,
            timeout=90,
            env={**env, "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        )
        pushed = bool(remote.stdout.strip())
        evidence["remoteBranch"] = evidence["remoteBranch"] or pushed
        evidence["subprojects"].append(
            {
                "name": sub["name"],
                "path": sub["path"],
                "aheadOfDev": len(ahead),
                "commits": ahead[:10],
                "pushedToOrigin": pushed,
            }
        )
    return evidence


def verify_delivery(monitor, config, feature, worktree):
    """Check the delivery receipt, tests and MR links for a finished feature."""
    feature_id = feature["id"]
    key = feature.get("jiraKey")
    host = config.get("gitlabHost", "gitblue.transwarp.io")
    scoped = Path(worktree) / ".automaker/jira" / feature_id / "jira-result.json"
    legacy = Path(worktree) / ".automaker/jira-result.json"
    result = {
        "receiptPath": None,
        "receiptShared": False,
        "outcome": None,
        "testsPassing": False,
        "testLog": None,
        "mergeRequests": [],
        "blockers": [],
        "validated": False,
        "notes": [],
    }
    path = scoped if scoped.exists() else (legacy if legacy.exists() else None)
    if path is None:
        result["notes"].append("没有交付回执（receipt）")
        return finish_verification(result, feature, worktree)
    result["receiptPath"] = str(path)
    result["receiptShared"] = path == legacy
    # A child feature shares its parent's worktree. The legacy root receipt there
    # belongs to the epic ("Parent decomposed into child tasks"), so attributing it
    # to the child would mark a finished child as blocked forever. Children must
    # bring their own feature-scoped receipt; until then only git evidence counts.
    unattributable = result["receiptShared"] and "-child-" in feature_id
    if unattributable:
        result["receiptAttributable"] = False
        try:
            shared = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            shared = {}
        result["sharedReceipt"] = {
            "outcome": shared.get("outcome"),
            "blockers": [str(b) for b in shared.get("blockers") or []],
            "note": "该回执属于父 Epic，不是本子任务的交付证据",
        }
        result["notes"].append(
            "worktree 根目录只有父 Epic 的回执（"
            + str(shared.get("outcome"))
            + "）；子任务缺少自己的 feature 级回执，改以 git 证据判定"
        )
        return finish_verification(result, feature, worktree)
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        result["notes"].append(f"回执无法解析: {error}")
        return result
    result["outcome"] = receipt.get("outcome")
    result["testsPassing"] = bool(monitor.tests_acceptable(receipt.get("tests", [])))
    result["testLog"] = receipt.get("testLog")
    urls = list(receipt.get("mergeRequests") or [])
    for project in receipt.get("changedProjects") or []:
        if isinstance(project, dict) and project.get("mrUrl"):
            urls.append(project["mrUrl"])
    result["mergeRequests"] = sorted({url for url in urls if url})
    result["blockers"] = [str(b) for b in receipt.get("blockers") or []]
    if key and worktree:
        result["validated"] = bool(
            monitor.validate_receipt(receipt, key, str(worktree), host)
        )
        result["artifactsValid"] = bool(
            monitor.has_valid_delivery_artifacts(receipt, key, str(worktree), host)
        )
    if result["receiptShared"]:
        result["notes"].append("回执取自 worktree 根目录（父/兄弟 feature 共享），可信度有限")
    if not result["validated"] and result["artifactsValid"]:
        result["notes"].append("测试与 MR 齐全，但回执带有未决 blocker")
    if not result["testsPassing"]:
        result["notes"].append("回执中的测试证据不完整")
    return finish_verification(result, feature, worktree)


def finish_verification(result, feature, worktree):
    """Attach git-level evidence and close out a verification record."""
    result["git"] = git_evidence(worktree, feature.get("branchName"))
    if not result["receiptPath"]:
        delivered = [s for s in result["git"]["subprojects"] if s["aheadOfDev"] > 0]
        result["notes"].append(
            "无回执；以 git 证据判定：" + (", ".join(
                f"{project_leaf(s['name'])} +{s['aheadOfDev']} commits ({'pushed' if s['pushedToOrigin'] else 'not pushed'})"
                for s in delivered
            ) or "该 worktree 没有相对 origin/dev 的提交")
        )
        result["gitDelivered"] = bool(delivered) and all(s["pushedToOrigin"] for s in delivered)
    return result


# ── prototype parity ─────────────────────────────────────────────────────────


def prototype_map(design_root):
    """Parse ROUTE_TO_PAGE_MAP.md into route/page/module rows."""
    rows = []
    path = Path(design_root) / "memory/ROUTE_TO_PAGE_MAP.md"
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\|\s*`?([^|`]+?)`?\s*\|\s*`?([^|`]+?)`?\s*\|\s*([^|]*)\|", line)
        if not match:
            continue
        route = match.group(1).strip()
        if not route.startswith("/") or route.startswith("~~"):
            continue
        rows.append(
            {
                "route": route,
                "page": match.group(2).strip(),
                "module": match.group(3).strip(),
                "text": f"{route} {match.group(2)} {match.group(3)}",
            }
        )
    return rows


def cjk_bigrams(text):
    chars = re.findall(r"[\u4e00-\u9fff]", text or "")
    return {chars[i] + chars[i + 1] for i in range(len(chars) - 1)}


def latin_tokens(text):
    return {token.lower() for token in re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", text or "")}


def match_prototype_routes(feature, rows, limit=3):
    """Rank prototype routes by CJK bigram and latin token overlap."""
    text = " ".join(
        str(feature.get(field) or "") for field in ("title", "description", "summary")
    )
    feature_bigrams = cjk_bigrams(text)
    feature_tokens = latin_tokens(text)
    scored = []
    for row in rows:
        row_bigrams = cjk_bigrams(row["text"])
        overlap = feature_bigrams & row_bigrams
        score = len(overlap) / math.sqrt(max(len(row_bigrams), 1))
        route_tokens = latin_tokens(row["route"].replace("/", " "))
        token_hits = feature_tokens & (route_tokens | latin_tokens(row["text"]))
        score += 0.4 * len(token_hits)
        if score > 0.05:
            scored.append((score, row["route"], row["module"], sorted(overlap)[:8], sorted(token_hits)))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return scored[:limit]


def resolve_route_params(design_root, route):
    """Replace ``:param`` segments with a mock id used by the prototype.

    The demo pages read their data from static mocks, so any literal id present
    in the source is a valid target; when nothing matches, ``demo`` is a
    best-effort placeholder and the screenshot records the failure.
    """
    params = re.findall(r":([A-Za-z0-9_]+)", route)
    if not params:
        return route
    source = (Path(design_root) / "design/src").resolve()
    roots = [source / "routes", source / "model", source / "config"]
    for param in params:
        replacement = None
        pattern = re.compile(rf"\b{param}\s*[:=]\s*['\"]([A-Za-z0-9_-]{{2,64}})['\"]")
        for root in roots:
            if not root.exists():
                continue
            for path in root.rglob("*.ts*"):
                try:
                    match = pattern.search(path.read_text(encoding="utf-8", errors="ignore"))
                except OSError:
                    continue
                if match:
                    replacement = match.group(1)
                    break
            if replacement:
                break
        route = route.replace(f":{param}", replacement or "demo")
    return route


def capture_parity(feature, worktree, config, run_dir, base_url):
    """Screenshot matching prototype routes as review evidence for a UI feature."""
    design_root = config.get("vibeDesignPath") or "/workspace/vibe-llmops/vibe-design"
    rows = prototype_map(design_root)
    matches = match_prototype_routes(feature, rows)
    evidence = {
        "designRoot": design_root,
        "prototypeBaseUrl": base_url,
        "routes": [],
        "screenshots": [],
        "changedFiles": [],
        "reviewRequired": True,
    }
    for sub in changed_subprojects(worktree):
        if sub["name"] not in UI_PROJECT_NAMES:
            continue
        path = Path(worktree) / sub["path"]
        if path.is_dir():
            code, out, _ = git(["diff", "--name-only", "origin/dev...HEAD"], path, 120)
            if code == 0 and out:
                evidence["changedFiles"] = out.splitlines()[:60]
    evidence["routes"] = [
        {"route": route, "module": module, "score": round(score, 3), "sharedTerms": terms}
        for score, route, module, terms, token_hits in matches
    ]
    if not evidence["routes"]:
        evidence["note"] = "没有匹配到原型路由；需要人工指定对照页面"
        return evidence
    out_dir = Path(run_dir) / "parity" / feature["id"]
    # ROUTE_TO_PAGE_MAP.md lists paths without the prototype's `/demo` base.
    base_path = config.get("vibeDesignBasePath", "/demo").rstrip("/")
    routes = [
        resolve_route_params(design_root, row["route"])
        if row["route"].startswith(base_path + "/")
        else resolve_route_params(design_root, base_path + row["route"])
        for row in evidence["routes"]
    ]
    command = [
        "node",
        str(SCRIPT_DIR / "parity-shot.mjs"),
        "--out",
        str(out_dir),
        "--base",
        base_url,
        *routes,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=180)
        if result.returncode == 0:
            evidence["screenshots"] = json.loads(result.stdout)
        else:
            evidence["note"] = result.stderr.strip()[:400]
    except Exception as error:
        evidence["note"] = str(error)
    evidence["labelCoverage"] = prototype_label_coverage(
        design_root, worktree, evidence["screenshots"]
    )
    return evidence


def prototype_label_coverage(design_root, worktree, screenshots):
    """Heuristic parity signal: prototype labels that the implementation covers.

    Labels are visible strings on the prototype page; the comparison looks for
    them in the changed frontend files (components plus i18n dictionaries). It is
    evidence for human review, not a pass/fail gate: mock copy and i18n keys can
    legitimately differ.
    """
    texts = []
    for shot in screenshots:
        if not shot.get("ok"):
            continue
        path = Path(str(shot.get("file")) + ".txt")
        if path.exists():
            texts.append(path.read_text(encoding="utf-8", errors="ignore"))
    if not texts:
        return {"note": "没有可读取的原型页面文本"}

    product_text = ""
    for sub in changed_subprojects(worktree):
        if sub["name"] not in UI_PROJECT_NAMES:
            continue
        path = Path(worktree) / sub["path"]
        if not path.is_dir():
            continue
        code, out, _ = git(["diff", "--name-only", "origin/dev", "HEAD"], path, 120)
        files = [line for line in out.splitlines() if line.strip()]
        code, out, _ = git(["status", "--porcelain"], path, 120)
        if code == 0 and out:
            files += [line[3:].strip().strip('"') for line in out.splitlines() if len(line) > 3]
        for relative in files[:80]:
            candidate = path / relative
            if candidate.suffix not in (".ts", ".tsx", ".json"):
                continue
            try:
                product_text += candidate.read_text(encoding="utf-8", errors="ignore") + "\n"
            except OSError:
                continue

    labels = set()
    for text in texts:
        for line in text.splitlines():
            line = line.strip()
            if not line or len(line) > 60:
                continue
            for cjk in re.findall(r"[\u4e00-\u9fff]{2,20}", line):
                labels.add(cjk)
            words = re.findall(r"[A-Za-z][A-Za-z'/-]{2,}", line)
            for start in range(len(words)):
                for size in (3, 2, 1):
                    if start + size > len(words):
                        continue
                    phrase = " ".join(words[start : start + size])
                    if size == 1 and len(phrase) < 6:
                        continue
                    labels.add(phrase)
    skip = {
        "Transwarp",
        "Catalog Discover",
        "Data Factory",
        "AI Factory",
        "Token Factory",
        "Coworker",
        "Discover",
        "Connector",
        "Governance",
    }
    labels = {label for label in labels if label not in skip}
    if not product_text or not labels:
        return {"note": "产品改动文件为空或原型页面无可比对文案", "labels": len(labels)}

    lower = product_text.lower()
    matched, missing = [], []
    for label in sorted(labels):
        (matched if label.lower() in lower else missing).append(label)
    return {
        "matched": len(matched),
        "total": len(labels),
        "missing": missing[:40],
        "matchedLabels": matched[:40],
        "note": "启发式比对：原型可见文案是否出现在产品改动文件（组件/i18n）中",
    }


# ── reporting ────────────────────────────────────────────────────────────────


def rewrite_report(run_dir, records, total, remaining):
    verified = [r for r in records if r.get("finalStatus") in FINISHED_STATUSES]
    review = [r for r in records if r.get("finalStatus") == "waiting_approval"]
    failed = [r for r in records if r.get("finalStatus") not in TERMINAL_STATUSES]
    lines = [
        "# Automaker 全量开发运行报告",
        "",
        f"- 更新时间：{now()}",
        f"- 队列总量：{total}；已完成并本地验证：{len(verified)}；"
        f"待人工裁决：{len(review)}；未完成：{len(failed)}；尚未开始：{remaining}",
        "",
        "## 已完成（本地验证通过）",
        "",
    ]
    if not verified:
        lines.append("_暂无_")
    for record in verified:
        delivery = record.get("verification") or {}
        projects = record.get("changedSubprojects") or [
            s.get("name") for s in (delivery.get("git") or {}).get("subprojects", [])
        ]
        lines.append(
            f"- `{record['featureId']}` {record.get('title', '')[:80]} "
            f"→ 改动项目 [{', '.join(project_leaf(p) for p in projects) or '—'}]，"
            f"测试证据 {delivery.get('testsPassing')}，MR {len(delivery.get('mergeRequests') or [])} 个"
        )
    lines += ["", "## 待人工裁决 / 需要输入", ""]
    if not review:
        lines.append("_暂无_")
    for record in review:
        delivery = record.get("verification") or {}
        blockers = "；".join(delivery.get("blockers") or [])[:220]
        projects = record.get("changedSubprojects") or [
            s.get("name") for s in (delivery.get("git") or {}).get("subprojects", [])
        ]
        lines.append(
            f"- `{record['featureId']}` {record.get('title', '')[:60]} — "
            f"改动项目 [{', '.join(project_leaf(p) for p in projects) or '—'}] "
            f"outcome={delivery.get('outcome')} {blockers}"
        )
    lines += ["", "## 未完成或失败", ""]
    if not failed:
        lines.append("_暂无_")
    for record in failed:
        lines.append(
            f"- `{record['featureId']}` 状态 {record.get('finalStatus')}：{record.get('error') or '—'}"
        )
    lines += [
        "",
        "## 原型对照证据",
        "",
        "每个前端交付的截图与路由匹配结果在 `data/run-all/parity/<featureId>/`。",
        "截图来自 3001 端口的 vibe-design 原型，仅作人工视觉对照的证据，机器不做视觉判定。",
        "",
    ]
    (Path(run_dir) / "RUN_REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


# ── main ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/workspace/automaker/data/jira-monitor/config.json")
    parser.add_argument("--run-dir", default="/workspace/automaker/data/run-all")
    parser.add_argument("--limit", type=int, default=0, help="stop after N features (0 = all)")
    parser.add_argument("--feature", action="append", default=[], help="only these feature ids")
    parser.add_argument("--status", default=",".join(STARTABLE_STATUSES))
    parser.add_argument("--timeout", type=int, default=5400, help="per-feature seconds")
    parser.add_argument("--max-attempts", type=int, default=2)
    parser.add_argument("--no-parity", action="store_true", help="skip prototype screenshots")
    parser.add_argument(
        "--no-draft-audit",
        action="store_true",
        help=argparse.SUPPRESS,  # Legacy flag; MR handling is now separate from task execution.
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    global LOGFILE
    run_dir = Path(args.run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    LOGFILE = run_dir / "runner.log"

    config = load_json(args.config)
    if not config:
        raise SystemExit(f"config not found: {args.config}")
    project = config["projectPath"]
    api = Api(config["automakerUrl"], Path(config["apiKeyFile"]).read_text().strip())
    monitor = monitor_module()

    features = api.call("features/list", {"projectPath": project})["features"]
    statuses = tuple(s.strip() for s in args.status.split(",") if s.strip())
    if args.feature:
        wanted = set(args.feature)
        features = [f for f in features if f["id"] in wanted]
    ordered, blocked, soft_deps = order_features(features, statuses)

    plan = [
        {
            "id": f["id"],
            "title": f.get("title"),
            "status": f.get("status"),
            "branchName": f.get("branchName"),
            "dependencies": f.get("dependencies") or [],
            "jiraKey": f.get("jiraKey"),
        }
        for f in ordered
    ]
    save_json(
        run_dir / "queue.json",
        {
            "project": project,
            "generatedAt": now(),
            "queue": plan,
            "blocked": blocked,
            "waitingApprovalDependencies": soft_deps,
        },
    )
    log(f"queue: {len(plan)} startable, {len(blocked)} blocked by incomplete dependencies")
    for feature, deps in blocked.items():
        log(f"  blocked: {feature} <- {', '.join(deps)}")
    for feature, deps in soft_deps.items():
        log(f"  note: {feature} runs on dependency {', '.join(deps)} that is waiting_approval (not verified)")

    if args.dry_run:
        for index, item in enumerate(plan, 1):
            print(f"{index:3d}. {item['id']:26s} {item['status']:9s} {(item['title'] or '')[:80]}")
        return 0

    records = [
        json.loads(line)
        for line in (run_dir / "progress.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ] if (run_dir / "progress.jsonl").exists() else []
    latest = {record["featureId"]: record for record in records}
    done = {r["featureId"] for r in records if r.get("finalStatus") in FINISHED_STATUSES and r.get("verification", {}).get("validated")}

    processed = 0
    for feature in ordered:
        if feature["id"] in done:
            log(f"skip {feature['id']} (already verified)")
            continue
        if args.limit and processed >= args.limit:
            log("limit reached; stopping")
            break
        processed += 1

        worktree = worktree_for_branch(project, feature.get("branchName")) if feature.get("branchName") else None
        record = {
            "featureId": feature["id"],
            "title": feature.get("title"),
            "jiraKey": feature.get("jiraKey"),
            "branchName": feature.get("branchName"),
            "worktree": str(worktree) if worktree else None,
            "dependencies": feature.get("dependencies") or [],
            "startedAt": now(),
        }
        log(f"=== {feature['id']} :: {feature.get('title')}")
        if worktree is None:
            record["finalStatus"] = "error"
            record["error"] = "找不到该分支的 worktree"
        else:
            try:
                live = feature_status(api, project, feature["id"])
                previous = latest.get(feature["id"])
                # Only a terminal result that the board has not touched since is
                # "done". A feature the board reset to backlog (rework signal) or a
                # run that failed must be picked up again.
                if (
                    previous
                    and previous.get("finalStatus") in TERMINAL_STATUSES
                    and previous.get("finalStatus") == live.get("status")
                ):
                    if (parse_ts(live.get("updatedAt")) or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)) <= (
                        parse_ts(previous.get("finishedAt")) or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)
                    ):
                        log(f"  unchanged since the last record ({live.get('status')}); skipping")
                        processed += 1
                        continue
                if live.get("status") in TERMINAL_STATUSES:
                    # Settled outside this runner (previous pass, server resume or
                    # the Jira monitor): adopt the result instead of re-running it.
                    log(f"  already settled as {live.get('status')}; adopting result")
                    record["adopted"] = True
                    current = live
                else:
                    ensure_delivery_directive(api, project, monitor, feature, worktree)
                    current = run_one(
                        api, project, feature, args.timeout, max_attempts=args.max_attempts
                    )
                record["finalStatus"] = current.get("status")
                record["error"] = current.get("error")
                record["verification"] = verify_delivery(monitor, config, feature, worktree)
                if not args.no_parity:
                    subprojects = changed_subprojects(worktree)
                    record["changedSubprojects"] = [s["name"] for s in subprojects]
                    if any(s["name"] in UI_PROJECT_NAMES for s in subprojects):
                        record["parity"] = capture_parity(
                            feature, worktree, config, run_dir, "http://127.0.0.1:3001"
                        )
                        log(f"  parity routes: {[r['route'] for r in record['parity'].get('routes', [])]}")
            except Exception as error:
                record["finalStatus"] = "error"
                record["error"] = str(error)
                log(f"  error: {error}")
        record["finishedAt"] = now()
        records = [r for r in records if r.get("featureId") != feature["id"]]
        records.append(record)
        latest[feature["id"]] = record
        with open(run_dir / "progress.jsonl", "w", encoding="utf-8") as handle:
            for existing in records:
                handle.write(json.dumps(existing, ensure_ascii=False) + "\n")
        rewrite_report(run_dir, records, len(ordered), len(ordered) - processed)

    rewrite_report(run_dir, records, len(ordered), 0)
    log("queue drained")
    return 0


if __name__ == "__main__":
    sys.exit(main())
