#!/usr/bin/env python3
"""
Isolated MacServer-free PyiCloud CloudKit Reminders probe & session migration tool.

Zero real Apple credentials, hosts, or customer PII are stored here.
Cookie files are written with 0600 permissions inside --cookie-dir only.
Never modifies legacy cookie source directories when importing.
"""
from __future__ import annotations

import argparse
import getpass
import http.cookiejar
import importlib.metadata
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

TRACKED_COOKIE_NAMES = (
    "X-APPLE-WEBAUTH-TOKEN",
    "X-APPLE-WEBAUTH-PCS-Cloudkit",
    "X-APPLE-WEBAUTH-HSA-TRUST",
)


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
    mock_list_deleted = RemindersList(id="list-deleted", title="Old Deleted", color="gray", deleted=True)
    service._reads.lists = MagicMock(return_value=[mock_list_allowed, mock_list_deleted])

    active = [lst.title for lst in service.lists() if not lst.deleted]
    sample_reminder = Reminder(
        id="rem-sample-1",
        list_id="list-allowed",
        title="Self-test sample reminder",
        completed=False,
        priority=1,
    )
    assert active == ["MUSE 测试"]
    assert sample_reminder.title == "Self-test sample reminder"

    print(
        json.dumps(
            {
                "ok": True,
                "mode": "self_test",
                "pyicloud_version": version,
                "filtered_lists": active,
            },
            ensure_ascii=False,
        )
    )
    return 0


def sanitize_apple_id(apple_id: str) -> str:
    return "".join(ch for ch in apple_id if ch.isalnum())


def harden_cookie_dir(cookie_dir: Path) -> None:
    cookie_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(cookie_dir, 0o700)
    for child in cookie_dir.iterdir():
        if child.is_file():
            os.chmod(child, 0o600)


def save_api_cookies(api, cookie_dir: Path) -> None:
    cookies = api.session.cookies
    if hasattr(cookies, "save"):
        cookies.save(ignore_discard=True, ignore_expires=False)
    harden_cookie_dir(cookie_dir)


def extract_cookie_ttls(cookies) -> tuple[float | None, float | None]:
    now = time.time()
    tracked_days: list[float] = []
    hsa_days: float | None = None
    for c in cookies:
        if c.name in TRACKED_COOKIE_NAMES and c.expires:
            rem = round((c.expires - now) / 86400, 1)
            tracked_days.append(rem)
            if c.name == "X-APPLE-WEBAUTH-HSA-TRUST":
                hsa_days = rem
    return (min(tracked_days) if tracked_days else None, hsa_days)


def load_cached_api(apple_id: str, cookie_dir: Path, china_mainland: bool):
    from pyicloud import PyiCloudService

    harden_cookie_dir(cookie_dir)
    api = PyiCloudService(
        apple_id=apple_id,
        password=None,
        cookie_directory=str(cookie_dir),
        china_mainland=china_mainland,
        authenticate=False,
    )
    try:
        data = api._validate_token()
    except Exception as exc:
        return None, str(exc)

    api.data = data
    api._update_state()
    save_api_cookies(api, cookie_dir)
    return api, None


def run_import_legacy_cookies(
    apple_id: str,
    cookie_dir: Path,
    src_dir: Path,
    china_mainland: bool,
) -> int:
    from pyicloud import PyiCloudService

    if not src_dir.is_dir():
        print(json.dumps({"ok": False, "error": f"Source cookie dir does not exist: {src_dir}"}))
        return 1

    sanitized = sanitize_apple_id(apple_id)
    legacy_jar = src_dir / f"{sanitized}.cookiejar"
    if not legacy_jar.exists():
        legacy_jar = src_dir / sanitized
    if not legacy_jar.exists():
        print(json.dumps({"ok": False, "error": f"No cookie jar matching {sanitized} found in {src_dir}"}))
        return 1

    harden_cookie_dir(cookie_dir)
    src_session = src_dir / f"{sanitized}.session"
    if src_session.is_file():
        dst_session = cookie_dir / f"{sanitized}.session"
        shutil.copy2(src_session, dst_session)
        os.chmod(dst_session, 0o600)

    api = PyiCloudService(
        apple_id=apple_id,
        password=None,
        cookie_directory=str(cookie_dir),
        china_mainland=china_mainland,
        authenticate=False,
    )
    jar = http.cookiejar.LWPCookieJar(str(legacy_jar))
    jar.load(ignore_discard=True, ignore_expires=False)
    imported = 0
    for cookie in jar:
        api.session.cookies.set_cookie(cookie)
        imported += 1
    save_api_cookies(api, cookie_dir)

    validated_api, err = load_cached_api(apple_id, cookie_dir, china_mainland)
    if not validated_api:
        print(
            json.dumps(
                {
                    "ok": False,
                    "mode": "import_legacy_cookies",
                    "cookies_imported": imported,
                    "error": err,
                },
                ensure_ascii=False,
            )
        )
        return 1

    min_days, hsa_days = extract_cookie_ttls(validated_api.session.cookies)
    print(
        json.dumps(
            {
                "ok": True,
                "mode": "import_legacy_cookies",
                "cookies_imported": imported,
                "trusted": bool(validated_api.is_trusted_session),
                "requires_2fa": bool(validated_api.requires_2fa),
                "cookie_min_remaining_days": min_days,
                "hsa_trust_remaining_days": hsa_days,
            },
            ensure_ascii=False,
        )
    )
    return 0


def run_check_session(apple_id: str, cookie_dir: Path, china_mainland: bool) -> int:
    harden_cookie_dir(cookie_dir)
    cookie_files = [p.name for p in cookie_dir.iterdir() if p.is_file()]
    if not cookie_files:
        print(
            json.dumps(
                {
                    "ok": True,
                    "status": "session_missing",
                    "trusted": False,
                    "cookie_min_remaining_days": None,
                    "hsa_trust_remaining_days": None,
                },
                ensure_ascii=False,
            )
        )
        return 0

    api, err = load_cached_api(apple_id, cookie_dir, china_mainland)
    if not api:
        print(
            json.dumps(
                {
                    "ok": True,
                    "status": "needs_2fa",
                    "trusted": False,
                    "cookie_min_remaining_days": None,
                    "hsa_trust_remaining_days": None,
                    "reason": err,
                },
                ensure_ascii=False,
            )
        )
        return 0

    min_days, hsa_days = extract_cookie_ttls(api.session.cookies)
    needs_2fa = bool(getattr(api, "requires_2fa", False) or getattr(api, "requires_2sa", False))
    trusted = bool(api.is_trusted_session)
    status = "ready" if (trusted and not needs_2fa) else "needs_2fa"
    print(
        json.dumps(
            {
                "ok": True,
                "status": status,
                "trusted": trusted,
                "cookie_min_remaining_days": min_days,
                "hsa_trust_remaining_days": hsa_days,
            },
            ensure_ascii=False,
        )
    )
    return 0


def run_bootstrap_2fa(apple_id: str, cookie_dir: Path, china_mainland: bool) -> int:
    from pyicloud import PyiCloudService

    password = getpass.getpass("Apple ID password (input hidden): ")
    if not password:
        print(json.dumps({"ok": False, "error": "Password cannot be empty"}))
        return 1

    harden_cookie_dir(cookie_dir)
    api = PyiCloudService(
        apple_id=apple_id,
        password=password,
        cookie_directory=str(cookie_dir),
        china_mainland=china_mainland,
        authenticate=True,
    )
    if getattr(api, "requires_2fa", False):
        code = input("Enter 6-digit Apple 2FA code: ").strip()
        if not api.validate_2fa_code(code):
            print(json.dumps({"ok": False, "status": "invalid_2fa_code"}, ensure_ascii=False))
            return 1
        if not api.is_trusted_session:
            api.trust_session()
    save_api_cookies(api, cookie_dir)
    print(json.dumps({"ok": True, "status": "ready", "trusted": bool(api.is_trusted_session)}, ensure_ascii=False))
    return 0


def run_probe_lists(apple_id: str, cookie_dir: Path, china_mainland: bool, allowed_list: str | None) -> int:
    api, err = load_cached_api(apple_id, cookie_dir, china_mainland)
    if not api:
        print(json.dumps({"ok": False, "status": "needs_2fa", "message": err}, ensure_ascii=False))
        return 1

    try:
        raw_lists = list(api.reminders.lists())
        deleted_skipped = sum(1 for lst in raw_lists if getattr(lst, "deleted", False))
        active_lists = [
            {"id": lst.id, "title": lst.title, "count": lst.count, "is_group": bool(lst.is_group)}
            for lst in raw_lists
            if not getattr(lst, "deleted", False) and (not allowed_list or lst.title == allowed_list)
        ]
        print(
            json.dumps(
                {
                    "ok": True,
                    "mode": "probe_lists_readonly",
                    "active_lists": active_lists,
                    "active_count": len(active_lists),
                    "deleted_tombstones_skipped": deleted_skipped,
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:
        msg = str(exc)
        adp_hint = bool(re.search(r"advanced data protection|manatee|pcs", msg, re.I))
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


def run_smoke_test_list(apple_id: str, cookie_dir: Path, china_mainland: bool, title: str) -> int:
    if "SYNTEST" not in title.upper() and "测试" not in title:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "REFUSED_NON_TEST_LIST",
                    "message": "Smoke test CRUD only allowed on synthetic/test lists containing 'SYNTEST' or '测试'",
                },
                ensure_ascii=False,
            )
        )
        return 1

    api, err = load_cached_api(apple_id, cookie_dir, china_mainland)
    if not api:
        print(json.dumps({"ok": False, "status": "needs_2fa", "message": err}, ensure_ascii=False))
        return 1

    try:
        active_lists = [lst for lst in api.reminders.lists() if not getattr(lst, "deleted", False)]
        target = next((lst for lst in active_lists if lst.title == title), None)
        if not target:
            print(json.dumps({"ok": False, "error": f"Active list '{title}' not found"}, ensure_ascii=False))
            return 1

        before_items = api.reminders.list_reminders(target.id, include_completed=False).reminders
        before_count = len(before_items)

        utc_ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        created = api.reminders.create(
            target.id,
            title=f"[CRM-CloudKit-Probe] {utc_ts}",
            desc="Automated CloudKit CRUD verification",
            priority=5,
        )

        readback_items = api.reminders.list_reminders(target.id, include_completed=False).reminders
        readback_ok = any(r.id == created.id for r in readback_items)
        if not readback_ok:
            raise RuntimeError(f"Created reminder {created.id} not observed on readback")

        created.completed = True
        api.reminders.update(created)

        api.reminders.delete(created)

        after_items = api.reminders.list_reminders(target.id, include_completed=False).reminders
        after_count = len(after_items)
        still_present = any(r.id == created.id for r in after_items)
        if still_present:
            raise RuntimeError(f"Deleted reminder {created.id} still returned after delete")

        print(
            json.dumps(
                {
                    "ok": True,
                    "mode": "smoke_test_crud",
                    "list_title": title,
                    "created_id": created.id,
                    "readback_ok": True,
                    "update_ok": True,
                    "delete_ok": True,
                    "before_count": before_count,
                    "after_count": after_count,
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "mode": "smoke_test_crud", "error": str(exc)}, ensure_ascii=False))
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Isolated PyiCloud CloudKit Reminders probe")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--self-test", action="store_true", help="Run offline Pydantic/mock self-test (no network)")
    group.add_argument("--check-session", action="store_true", help="Validate cached cookie session without SRP login")
    group.add_argument("--bootstrap-2fa", action="store_true", help="Interactive terminal login + 2FA trust")
    group.add_argument("--probe-lists", action="store_true", help="Read-only CloudKit active list discovery")
    group.add_argument("--import-legacy-cookies", metavar="SRC_DIR", help="Copy & convert legacy cookiejar into --cookie-dir")
    group.add_argument("--smoke-test-list", metavar="TITLE", help="Run safe CRUD round-trip on an isolated test list")

    parser.add_argument("--apple-id", help="Apple ID email (required unless --self-test)")
    parser.add_argument("--cookie-dir", help="Cookie storage directory (required unless --self-test)")
    parser.add_argument("--china-mainland", action="store_true", help="Use icloud.com.cn endpoints")
    parser.add_argument("--allowed-list", default=None, help="Optional exact list title filter")

    args = parser.parse_args()

    if args.self_test:
        return run_self_test()

    if not args.apple_id or not args.cookie_dir:
        parser.error("--apple-id and --cookie-dir are required for session/probe commands")

    cookie_dir = Path(args.cookie_dir).expanduser().resolve()
    if args.import_legacy_cookies:
        return run_import_legacy_cookies(
            args.apple_id, cookie_dir, Path(args.import_legacy_cookies).expanduser().resolve(), args.china_mainland
        )
    if args.check_session:
        return run_check_session(args.apple_id, cookie_dir, args.china_mainland)
    if args.bootstrap_2fa:
        return run_bootstrap_2fa(args.apple_id, cookie_dir, args.china_mainland)
    if args.probe_lists:
        return run_probe_lists(args.apple_id, cookie_dir, args.china_mainland, args.allowed_list)
    if args.smoke_test_list:
        return run_smoke_test_list(args.apple_id, cookie_dir, args.china_mainland, args.smoke_test_list)
    return 1


if __name__ == "__main__":
    sys.exit(main())
