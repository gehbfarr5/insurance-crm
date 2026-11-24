#!/usr/bin/env python3
"""
Isolated MacServer-free PyiCloud CloudKit Reminders probe.

Zero real Apple credentials, hosts, or customer PII are stored here.
Cookie files are written with 0600 permissions inside --cookie-dir only.
"""
from __future__ import annotations

import argparse
import getpass
import importlib.metadata
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock


def run_self_test() -> int:
    from pyicloud.services.reminders import Reminder, RemindersList, RemindersService

    try:
        version = importlib.metadata.version("pyicloud")
    except Exception:
        version = "unknown"

    mock_session = MagicMock()
    service = RemindersService(
        service_root="https://p123-remindersws.icloud.com",
        session=mock_session,
        params={"dsid": "00000000"},
    )
    mock_list_allowed = RemindersList(id="list-allowed", title="MUSE 测试", color="blue")
    mock_list_other = RemindersList(id="list-other", title="Personal", color="orange")
    service._reads.lists = MagicMock(return_value=[mock_list_allowed, mock_list_other])

    allowed_title = "MUSE 测试"
    filtered = [lst.title for lst in service.lists() if lst.title == allowed_title]
    sample_reminder = Reminder(
        id="rem-sample-1",
        list_id="list-allowed",
        title="Self-test sample reminder",
        completed=False,
        priority=1,
    )
    assert filtered == [allowed_title]
    assert sample_reminder.title == "Self-test sample reminder"

    print(
        json.dumps(
            {
                "ok": True,
                "mode": "self_test",
                "pyicloud_version": version,
                "filtered_lists": filtered,
            },
            ensure_ascii=False,
        )
    )
    return 0


def harden_cookie_dir(cookie_dir: Path) -> None:
    cookie_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(cookie_dir, 0o700)
    for child in cookie_dir.iterdir():
        if child.is_file():
            os.chmod(child, 0o600)


def build_api(apple_id: str, cookie_dir: Path, china_mainland: bool, password: str | None = None):
    from pyicloud import PyiCloudService

    harden_cookie_dir(cookie_dir)
    kwargs = {
        "apple_id": apple_id,
        "cookie_directory": str(cookie_dir),
        "china_mainland": china_mainland,
        "authenticate": True,
    }
    if password is not None:
        kwargs["password"] = password
    return PyiCloudService(**kwargs)


def run_check_session(apple_id: str, cookie_dir: Path, china_mainland: bool) -> int:
    harden_cookie_dir(cookie_dir)
    cookie_files = [p.name for p in cookie_dir.iterdir() if p.is_file()]
    if not cookie_files:
        print(json.dumps({"ok": True, "status": "session_missing", "cookie_files": 0}, ensure_ascii=False))
        return 0

    try:
        api = build_api(apple_id, cookie_dir, china_mainland, password="")
        harden_cookie_dir(cookie_dir)
        if getattr(api, "requires_2fa", False) or getattr(api, "requires_2sa", False):
            print(json.dumps({"ok": True, "status": "needs_2fa", "cookie_files": len(cookie_files)}, ensure_ascii=False))
            return 0
        print(json.dumps({"ok": True, "status": "ready", "cookie_files": len(cookie_files)}, ensure_ascii=False))
        return 0
    except Exception as exc:
        msg = str(exc)
        status = "needs_2fa" if ("2fa" in msg.lower() or "password" in msg.lower()) else "error"
        print(json.dumps({"ok": False, "status": status, "message": msg}, ensure_ascii=False))
        return 1 if status == "error" else 0


def run_bootstrap_2fa(apple_id: str, cookie_dir: Path, china_mainland: bool) -> int:
    password = getpass.getpass("Apple ID password (input hidden): ")
    api = build_api(apple_id, cookie_dir, china_mainland, password=password)
    if getattr(api, "requires_2fa", False):
        code = input("Enter 6-digit Apple 2FA code: ").strip()
        if not api.validate_2fa_code(code):
            print(json.dumps({"ok": False, "status": "invalid_2fa_code"}, ensure_ascii=False))
            return 1
        if not api.is_trusted_session:
            api.trust_session()
    harden_cookie_dir(cookie_dir)
    print(json.dumps({"ok": True, "status": "ready", "trusted": bool(api.is_trusted_session)}, ensure_ascii=False))
    return 0


def run_probe_lists(apple_id: str, cookie_dir: Path, china_mainland: bool, allowed_list: str | None) -> int:
    try:
        api = build_api(apple_id, cookie_dir, china_mainland, password="")
        harden_cookie_dir(cookie_dir)
        if getattr(api, "requires_2fa", False):
            print(json.dumps({"ok": False, "status": "needs_2fa"}, ensure_ascii=False))
            return 1
        lists = list(api.reminders.lists())
        summaries = [
            {"title": lst.title, "count": lst.count, "is_group": bool(lst.is_group)}
            for lst in lists
            if not allowed_list or lst.title == allowed_list
        ]
        print(
            json.dumps(
                {
                    "ok": True,
                    "mode": "probe_lists_readonly",
                    "total_lists": len(lists),
                    "matched_lists": summaries,
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:
        msg = str(exc)
        adp_hint = "advanced data protection" in msg.lower() or "manatee" in msg.lower() or "pcs" in msg.lower()
        print(
            json.dumps(
                {
                    "ok": False,
                    "status": "cloudkit_error",
                    "possible_adp_block": adp_hint,
                    "message": msg,
                },
                ensure_ascii=False,
            )
        )
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Isolated PyiCloud CloudKit Reminders probe (read-only)")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--self-test", action="store_true", help="Run offline Pydantic/mock self-test (no network)")
    group.add_argument("--check-session", action="store_true", help="Check saved cookie session state without triggering 2FA")
    group.add_argument("--bootstrap-2fa", action="store_true", help="Interactive terminal login + 2FA trust")
    group.add_argument("--probe-lists", action="store_true", help="Read-only CloudKit list count/title discovery")

    parser.add_argument("--apple-id", help="Apple ID email (required unless --self-test)")
    parser.add_argument("--cookie-dir", help="Cookie storage directory (required unless --self-test)")
    parser.add_argument("--china-mainland", action="store_true", help="Use icloud.com.cn endpoints")
    parser.add_argument("--allowed-list", default=None, help="Optional exact list title filter (e.g. MUSE 测试)")

    args = parser.parse_args()

    if args.self_test:
        return run_self_test()

    if not args.apple_id or not args.cookie_dir:
        parser.error("--apple-id and --cookie-dir are required for session/probe commands")

    cookie_dir = Path(args.cookie_dir).expanduser().resolve()
    if args.check_session:
        return run_check_session(args.apple_id, cookie_dir, args.china_mainland)
    if args.bootstrap_2fa:
        return run_bootstrap_2fa(args.apple_id, cookie_dir, args.china_mainland)
    if args.probe_lists:
        return run_probe_lists(args.apple_id, cookie_dir, args.china_mainland, args.allowed_list)
    return 1


if __name__ == "__main__":
    sys.exit(main())
