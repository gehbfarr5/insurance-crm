#!/usr/bin/env python3
"""
Isolated MacServer-free PyiCloud CloudKit Reminders local HTTP bridge.

Runs outside Docker in its own venv, exposes loopback/Docker-bridge HTTP
protected by Bearer token auth (`PYICLOUD_BRIDGE_TOKEN`), and enforces a
fail-closed write lock (`PYICLOUD_REMINDERS_WRITE_ENABLED=false` by default).
Zero real Apple credentials, hosts, or customer PII are stored here.
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import sys
import threading
import time
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TRACKED_COOKIE_NAMES = (
    "X-APPLE-WEBAUTH-TOKEN",
    "X-APPLE-WEBAUTH-PCS-Cloudkit",
    "X-APPLE-WEBAUTH-HSA-TRUST",
)


def parse_bool(raw: str | None, default: bool = False) -> bool:
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def parse_csv_set(raw: str | None) -> set[str]:
    if not raw:
        return set()
    return {part.strip() for part in raw.split(",") if part.strip()}


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


def serialize_reminder(rem, list_title: str | None = None) -> dict:
    payload = {
        "id": rem.id,
        "list_id": rem.list_id,
        "title": rem.title,
        "desc": getattr(rem, "desc", "") or "",
        "completed": bool(rem.completed),
        "due_date": rem.due_date.isoformat() if getattr(rem, "due_date", None) else None,
        "priority": getattr(rem, "priority", 0),
        "flagged": bool(getattr(rem, "flagged", False)),
    }
    if list_title is not None:
        payload["list_title"] = list_title
    return payload


class BridgeConfig:
    def __init__(self, env: dict[str, str]):
        self.host = env.get("PYICLOUD_BRIDGE_HOST", "127.0.0.1")
        self.port = int(env.get("PYICLOUD_BRIDGE_PORT", "18768"))
        self.token = env.get("PYICLOUD_BRIDGE_TOKEN", "").strip()
        self.apple_id = env.get("PYICLOUD_APPLE_ID", "").strip()
        self.cookie_dir = env.get("PYICLOUD_COOKIE_DIR", "").strip()
        self.china_mainland = parse_bool(env.get("PYICLOUD_CHINA_MAINLAND"), False)
        self.read_allowed_lists = parse_csv_set(env.get("PYICLOUD_READ_ALLOWED_LISTS"))
        self.write_allowed_lists = parse_csv_set(env.get("PYICLOUD_WRITE_ALLOWED_LISTS"))
        self.write_enabled = parse_bool(env.get("PYICLOUD_REMINDERS_WRITE_ENABLED"), False)


class CloudKitRemindersState:
    def __init__(self, cfg: BridgeConfig):
        self.cfg = cfg
        self.lock = threading.Lock()
        self._api = None
        self._validated_at = 0.0
        self._last_error: str | None = None

    def _harden_cookies(self) -> None:
        cdir = Path(self.cfg.cookie_dir)
        cdir.mkdir(parents=True, exist_ok=True)
        os.chmod(cdir, 0o700)
        for child in cdir.iterdir():
            if child.is_file():
                os.chmod(child, 0o600)

    def _get_api_locked(self, force_revalidate: bool = False):
        from pyicloud import PyiCloudService

        now = time.monotonic()
        if not force_revalidate and self._api is not None and (now - self._validated_at) < 300.0:
            return self._api

        self._harden_cookies()
        api = PyiCloudService(
            apple_id=self.cfg.apple_id,
            password=None,
            cookie_directory=self.cfg.cookie_dir,
            china_mainland=self.cfg.china_mainland,
            authenticate=False,
        )
        data = api._validate_token()
        api.data = data
        api._update_state()
        if hasattr(api.session.cookies, "save"):
            api.session.cookies.save(ignore_discard=True, ignore_expires=False)
        self._harden_cookies()
        self._api = api
        self._validated_at = now
        self._last_error = None
        return api

    def get_health(self) -> dict:
        with self.lock:
            try:
                api = self._get_api_locked()
                min_days, hsa_days = extract_cookie_ttls(api.session.cookies)
                active_lists = [lst for lst in api.reminders.lists() if not getattr(lst, "deleted", False)]
                trusted = bool(api.is_trusted_session)
                needs_2fa = bool(getattr(api, "requires_2fa", False) or getattr(api, "requires_2sa", False))
                authed = trusted and not needs_2fa
                return {
                    "status": "ok" if authed else "degraded",
                    "engine": "pyicloud-cloudkit",
                    "macserver_dependency": False,
                    "authenticated": authed,
                    "trusted": trusted,
                    "active_lists_count": len(active_lists),
                    "write_enabled": self.cfg.write_enabled,
                    "cookie_min_remaining_days": min_days,
                    "hsa_trust_remaining_days": hsa_days,
                }
            except Exception as exc:
                self._api = None
                self._last_error = str(exc)
                return {
                    "status": "degraded",
                    "engine": "pyicloud-cloudkit",
                    "macserver_dependency": False,
                    "authenticated": False,
                    "trusted": False,
                    "active_lists_count": 0,
                    "write_enabled": self.cfg.write_enabled,
                    "cookie_min_remaining_days": None,
                    "hsa_trust_remaining_days": None,
                    "error": self._last_error,
                }

    def list_lists(self) -> dict:
        with self.lock:
            api = self._get_api_locked()
            raw = list(api.reminders.lists())
            lists = [
                {
                    "list_id": lst.id,
                    "title": lst.title,
                    "count": lst.count,
                    "color": getattr(lst, "color", None),
                }
                for lst in raw
                if not getattr(lst, "deleted", False)
            ]
            return {"engine": "pyicloud-cloudkit", "lists": lists}

    def list_reminders(self, list_title: str, include_completed: bool) -> tuple[int, dict]:
        if not list_title or list_title not in self.cfg.read_allowed_lists:
            return 403, {
                "error": "LIST_NOT_IN_READ_ALLOWLIST",
                "message": f"List '{list_title}' is not permitted by PYICLOUD_READ_ALLOWED_LISTS",
            }
        with self.lock:
            api = self._get_api_locked()
            target = next(
                (
                    lst
                    for lst in api.reminders.lists()
                    if not getattr(lst, "deleted", False) and lst.title == list_title
                ),
                None,
            )
            if not target:
                return 404, {"error": "LIST_NOT_FOUND", "message": f"List '{list_title}' not found"}
            res = api.reminders.list_reminders(target.id, include_completed=include_completed)
            return 200, {
                "list_id": target.id,
                "list_title": target.title,
                "reminders": [serialize_reminder(r, target.title) for r in res.reminders],
            }

    def _check_write_gate(self, list_title: str | None) -> tuple[int, dict] | None:
        if not self.cfg.write_enabled:
            return 403, {
                "error": "REMINDERS_WRITE_LOCKED",
                "message": "PyiCloud Reminders write gate is locked (PYICLOUD_REMINDERS_WRITE_ENABLED=false)",
            }
        if list_title is not None and list_title not in self.cfg.write_allowed_lists:
            return 403, {
                "error": "LIST_NOT_IN_WRITE_ALLOWLIST",
                "message": f"List '{list_title}' is not permitted by PYICLOUD_WRITE_ALLOWED_LISTS",
            }
        return None

    def create_reminder(self, body: dict) -> tuple[int, dict]:
        list_title = str(body.get("list_title") or "").strip()
        gate_err = self._check_write_gate(list_title)
        if gate_err:
            return gate_err
        title = str(body.get("title") or "").strip()
        if not title:
            return 400, {"error": "INVALID_INPUT", "message": "title is required"}

        due_dt = None
        if body.get("due_date"):
            due_dt = datetime.fromisoformat(str(body["due_date"]))
        all_day = bool(body.get("all_day", False))
        time_zone = body.get("time_zone")
        if due_dt is not None and not all_day and not time_zone:
            time_zone = "Asia/Shanghai"

        with self.lock:
            api = self._get_api_locked()
            target = next(
                (
                    lst
                    for lst in api.reminders.lists()
                    if not getattr(lst, "deleted", False) and lst.title == list_title
                ),
                None,
            )
            if not target:
                return 404, {"error": "LIST_NOT_FOUND", "message": f"List '{list_title}' not found"}
            created = api.reminders.create(
                target.id,
                title=title,
                desc=str(body.get("desc") or ""),
                due_date=due_dt,
                priority=int(body.get("priority") or 0),
                flagged=bool(body.get("flagged", False)),
                all_day=all_day,
                time_zone=time_zone,
            )
            return 201, serialize_reminder(created, target.title)

    def update_reminder(self, reminder_id: str, body: dict) -> tuple[int, dict]:
        gate_err = self._check_write_gate(None)
        if gate_err:
            return gate_err
        with self.lock:
            api = self._get_api_locked()
            rem = api.reminders.get(reminder_id)
            list_obj = next(
                (lst for lst in api.reminders.lists() if not getattr(lst, "deleted", False) and lst.id == rem.list_id),
                None,
            )
            if not list_obj or list_obj.title not in self.cfg.write_allowed_lists:
                return 403, {"error": "LIST_NOT_IN_WRITE_ALLOWLIST"}
            if "title" in body and body["title"] is not None:
                rem.title = str(body["title"])
            if "desc" in body and body["desc"] is not None:
                rem.desc = str(body["desc"])
            if "completed" in body and body["completed"] is not None:
                rem.completed = bool(body["completed"])
            if "priority" in body and body["priority"] is not None:
                rem.priority = int(body["priority"])
            if "flagged" in body and body["flagged"] is not None:
                rem.flagged = bool(body["flagged"])
            if "due_date" in body:
                if body["due_date"] is None:
                    rem.due_date = None
                else:
                    rem.due_date = datetime.fromisoformat(str(body["due_date"]))
            api.reminders.update(rem)
            return 200, serialize_reminder(rem, list_obj.title)

    def delete_reminder(self, reminder_id: str) -> tuple[int, dict]:
        gate_err = self._check_write_gate(None)
        if gate_err:
            return gate_err
        with self.lock:
            api = self._get_api_locked()
            rem = api.reminders.get(reminder_id)
            list_obj = next(
                (lst for lst in api.reminders.lists() if not getattr(lst, "deleted", False) and lst.id == rem.list_id),
                None,
            )
            if not list_obj or list_obj.title not in self.cfg.write_allowed_lists:
                return 403, {"error": "LIST_NOT_IN_WRITE_ALLOWLIST"}
            api.reminders.delete(rem)
            return 200, {"deleted": True, "id": reminder_id}


def check_bearer_auth(auth_header: str | None, expected_token: str) -> bool:
    if not auth_header or not auth_header.startswith("Bearer "):
        return False
    supplied = auth_header[len("Bearer ") :].strip()
    if not supplied or not expected_token:
        return False
    return hmac.compare_digest(supplied, expected_token)


def make_handler(state: CloudKitRemindersState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:
            sys.stderr.write(f"[pyicloud-bridge] {self.address_string()} - {format % args}\n")

        def _send_json(self, code: int, payload: dict) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _require_auth(self) -> bool:
            if not check_bearer_auth(self.headers.get("Authorization"), state.cfg.token):
                self._send_json(401, {"error": "UNAUTHORIZED", "message": "Valid Bearer token required"})
                return False
            return True

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length <= 0:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))

        def do_GET(self) -> None:
            if not self._require_auth():
                return
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            qs = urllib.parse.parse_qs(parsed.query)
            try:
                if path == "/health":
                    self._send_json(200, state.get_health())
                elif path == "/lists":
                    self._send_json(200, state.list_lists())
                elif path == "/reminders":
                    list_title = (qs.get("list_title") or [""])[0]
                    inc_comp = parse_bool((qs.get("include_completed") or ["false"])[0], False)
                    code, data = state.list_reminders(list_title, inc_comp)
                    self._send_json(code, data)
                else:
                    self._send_json(404, {"error": "NOT_FOUND"})
            except Exception as exc:
                self._send_json(502, {"error": "UPSTREAM_ERROR", "message": str(exc)})

        def do_POST(self) -> None:
            if not self._require_auth():
                return
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path.rstrip("/")
            try:
                if path == "/reminders":
                    body = self._read_json()
                    code, data = state.create_reminder(body)
                    self._send_json(code, data)
                else:
                    self._send_json(404, {"error": "NOT_FOUND"})
            except Exception as exc:
                self._send_json(502, {"error": "UPSTREAM_ERROR", "message": str(exc)})

        def do_PATCH(self) -> None:
            if not self._require_auth():
                return
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path.rstrip("/")
            try:
                if path.startswith("/reminders/"):
                    rem_id = urllib.parse.unquote(path[len("/reminders/") :])
                    body = self._read_json()
                    code, data = state.update_reminder(rem_id, body)
                    self._send_json(code, data)
                else:
                    self._send_json(404, {"error": "NOT_FOUND"})
            except Exception as exc:
                self._send_json(502, {"error": "UPSTREAM_ERROR", "message": str(exc)})

        def do_DELETE(self) -> None:
            if not self._require_auth():
                return
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path.rstrip("/")
            try:
                if path.startswith("/reminders/"):
                    rem_id = urllib.parse.unquote(path[len("/reminders/") :])
                    code, data = state.delete_reminder(rem_id)
                    self._send_json(code, data)
                else:
                    self._send_json(404, {"error": "NOT_FOUND"})
            except Exception as exc:
                self._send_json(502, {"error": "UPSTREAM_ERROR", "message": str(exc)})

    return Handler


def run_self_test() -> int:
    from pyicloud.services.reminders import RemindersService  # noqa: F401

    cfg = BridgeConfig(
        {
            "PYICLOUD_BRIDGE_TOKEN": "unit-test-secret",
            "PYICLOUD_APPLE_ID": "test@example.com",
            "PYICLOUD_COOKIE_DIR": "/tmp/nonexistent",
            "PYICLOUD_READ_ALLOWED_LISTS": "工作待办 Work,MUSE-R1-04-SYNTEST",
            "PYICLOUD_WRITE_ALLOWED_LISTS": "MUSE-R1-04-SYNTEST",
            "PYICLOUD_REMINDERS_WRITE_ENABLED": "false",
        }
    )
    state = CloudKitRemindersState(cfg)
    assert check_bearer_auth("Bearer unit-test-secret", cfg.token) is True
    assert check_bearer_auth("Bearer wrong", cfg.token) is False
    assert check_bearer_auth(None, cfg.token) is False

    code_write, err_write = state.create_reminder({"list_title": "MUSE-R1-04-SYNTEST", "title": "x"})
    assert code_write == 403 and err_write["error"] == "REMINDERS_WRITE_LOCKED"

    code_read, err_read = state.list_reminders("Unauthorized List", False)
    assert code_read == 403 and err_read["error"] == "LIST_NOT_IN_READ_ALLOWLIST"

    cfg_unlocked = BridgeConfig(
        {
            "PYICLOUD_BRIDGE_TOKEN": "unit-test-secret",
            "PYICLOUD_APPLE_ID": "test@example.com",
            "PYICLOUD_COOKIE_DIR": "/tmp/nonexistent",
            "PYICLOUD_READ_ALLOWED_LISTS": "工作待办 Work,MUSE-R1-04-SYNTEST",
            "PYICLOUD_WRITE_ALLOWED_LISTS": "MUSE-R1-04-SYNTEST",
            "PYICLOUD_REMINDERS_WRITE_ENABLED": "true",
        }
    )
    state_unlocked = CloudKitRemindersState(cfg_unlocked)
    code_unlisted, err_unlisted = state_unlocked.create_reminder({"list_title": "工作待办 Work", "title": "x"})
    assert code_unlisted == 403 and err_unlisted["error"] == "LIST_NOT_IN_WRITE_ALLOWLIST"

    print(
        json.dumps(
            {
                "ok": True,
                "mode": "service_self_test",
                "write_lock": "verified",
                "allowlist": "verified",
                "auth": "verified",
            }
        )
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Isolated PyiCloud CloudKit Reminders HTTP bridge")
    parser.add_argument("--self-test", action="store_true", help="Run offline unit verification without network")
    args = parser.parse_args()
    if args.self_test:
        return run_self_test()

    cfg = BridgeConfig(dict(os.environ))
    if not cfg.token or not cfg.apple_id or not cfg.cookie_dir:
        sys.stderr.write("FATAL: PYICLOUD_BRIDGE_TOKEN, PYICLOUD_APPLE_ID, and PYICLOUD_COOKIE_DIR are required\n")
        return 1

    state = CloudKitRemindersState(cfg)
    server = ThreadingHTTPServer((cfg.host, cfg.port), make_handler(state))
    sys.stderr.write(
        f"[pyicloud-bridge] listening on http://{cfg.host}:{cfg.port} "
        f"(write_enabled={cfg.write_enabled})\n"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
