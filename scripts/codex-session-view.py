#!/usr/bin/env python3
"""Render the real Codex conversation for an Automaker task.

Automaker's agent-output.md is a flattened log. The complete conversation
(messages, reasoning, tool calls and results) lives in Codex session files under
~/.codex/sessions. This viewer finds the session for a worktree and prints it.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

SESSIONS_DIR = Path(os.environ.get("CODEX_SESSIONS_DIR", Path.home() / ".codex" / "sessions"))
TRUNCATE = 2000


def session_cwd(path: Path) -> str | None:
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for _ in range(5):
                line = handle.readline()
                if not line:
                    break
                record = json.loads(line)
                if record.get("type") == "session_meta":
                    return record.get("payload", {}).get("cwd")
    except (OSError, ValueError):
        return None
    return None


def find_sessions(worktree: str) -> list[Path]:
    target = str(Path(worktree).expanduser().resolve())
    matches = []
    for path in SESSIONS_DIR.rglob("*.jsonl"):
        cwd = session_cwd(path)
        if cwd and str(Path(cwd).resolve()) == target:
            matches.append(path)
    return sorted(matches, key=lambda item: item.stat().st_size, reverse=True)


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict):
            parts.append(block.get("text") or block.get("content") or "")
    return "\n".join(part for part in parts if part)


def clip(value: str, full: bool) -> str:
    value = value.rstrip()
    if full or len(value) <= TRUNCATE:
        return value
    return value[:TRUNCATE] + f"\n... [{len(value) - TRUNCATE} chars truncated; use --full]"


def render_record(record: dict, full: bool, thinking: bool) -> str | None:
    if record.get("type") != "response_item":
        return None
    payload = record.get("payload") or {}
    kind = payload.get("type")

    if kind == "message":
        role = payload.get("role")
        text = text_of(payload.get("content"))
        if not text:
            return None
        if role == "assistant":
            return f"\n[ASSISTANT]\n{clip(text, full)}"
        if role == "user":
            return f"\n[USER]\n{clip(text, full)}"
        return None

    if kind == "reasoning":
        if not thinking:
            return None
        text = "\n".join(
            block.get("text", "")
            for block in payload.get("content", [])
            if isinstance(block, dict)
        )
        return f"\n[THINKING]\n{clip(text, full)}" if text.strip() else None

    if kind in ("function_call", "custom_tool_call"):
        name = payload.get("name") or payload.get("tool") or "tool"
        arguments = payload.get("arguments") or payload.get("input") or ""
        if not isinstance(arguments, str):
            arguments = json.dumps(arguments, ensure_ascii=False)
        return f"\n[TOOL] {name}\n{clip(arguments, full)}"

    if kind in ("function_call_output", "custom_tool_call_output"):
        output = payload.get("output") or payload.get("result") or ""
        if not isinstance(output, str):
            output = json.dumps(output, ensure_ascii=False)
        return f"\n[RESULT]\n{clip(output, full)}"

    return None


def render_file(path: Path, full: bool, thinking: bool, last: int | None) -> int:
    rendered = []
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            block = render_record(record, full, thinking)
            if block:
                rendered.append(block)
    if last:
        rendered = rendered[-last:]
    for block in rendered:
        print(block)
    return path.stat().st_size


def follow(path: Path, offset: int, full: bool, thinking: bool) -> None:
    print(f"\n--- following {path} (Ctrl-C to stop) ---", flush=True)
    while True:
        time.sleep(1)
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if size <= offset:
            continue
        with path.open(encoding="utf-8", errors="replace") as handle:
            handle.seek(offset)
            for line in handle:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                block = render_record(record, full, thinking)
                if block:
                    print(block, flush=True)
            offset = handle.tell()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worktree", help="Task worktree, e.g. /workspace/vibe-llmops/.worktrees/aip-114829-kaka")
    parser.add_argument("--session", help="Explicit Codex session .jsonl file")
    parser.add_argument("--list", action="store_true", help="List matching sessions and exit")
    parser.add_argument("--last", type=int, help="Only render the last N conversation blocks")
    parser.add_argument("--full", action="store_true", help="Do not truncate long content")
    parser.add_argument("--thinking", action="store_true", help="Include model reasoning blocks")
    parser.add_argument("--follow", action="store_true", help="Keep printing new conversation blocks")
    args = parser.parse_args()

    if args.session:
        sessions = [Path(args.session).expanduser()]
    elif args.worktree:
        sessions = find_sessions(args.worktree)
        if not sessions:
            parser.error(f"no Codex session found for worktree: {args.worktree}")
    else:
        parser.error("provide --worktree or --session")

    if args.list:
        for path in sessions:
            updated = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(path.stat().st_mtime))
            print(f"{updated}  {path.stat().st_size:>10}  {path}")
        return 0

    # The largest matching session is normally the main task session; subagents
    # and resumed threads produce smaller additional sessions in the same cwd.
    session = max(sessions, key=lambda item: item.stat().st_size)
    offset = render_file(session, args.full, args.thinking, args.last)
    if args.follow:
        follow(session, offset, args.full, args.thinking)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
