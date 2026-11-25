#!/bin/sh
set -eu

# Zero-dependency KJGX Worker / Heartbeat Client (POSIX sh + curl / Termux curl).
# Designed to run natively on rooted Android/Pixel devices without Node.js or Python.
# Note: At boot, Magisk /data/adb/service.d/ invokes this via `/system/bin/sh`.

DEFAULT_ENV_FILE="${WORKER_ENV_FILE:-/data/adb/crm-worker/worker.env}"
if [ -f "$DEFAULT_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$DEFAULT_ENV_FILE"
  set +a
fi

ONCE=0
CLAIM_MODE=0
for arg in "$@"; do
  case "$arg" in
    --once) ONCE=1 ;;
    --claim) CLAIM_MODE=1 ;;
  esac
done

: "${CRM_API_URL:?CRM_API_URL is required (e.g. https://<host>:<port>/crm)}"
: "${CRM_WORKER_TOKEN:?CRM_WORKER_TOKEN is required (Bearer key)}"

KJGX_DEVICE_ID="${KJGX_DEVICE_ID:-pixel3a-kjgx}"
KJGX_PACKAGE="${KJGX_PACKAGE:-com.cpic.kjgxplus}"
KJGX_BUNDLE_PATH="${KJGX_BUNDLE_PATH:-/data/user/0/com.cpic.kjgxplus/files/react_native/Android/index.android.bundle}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-30}"
API_BASE="${CRM_API_URL%/}"

CURL_BIN="${CURL_BIN:-}"
CURL_LD_PATH=""
CURL_CACERT="${SSL_CERT_FILE:-}"
if [ -z "$CURL_BIN" ]; then
  if [ -x /data/data/com.termux/files/usr/bin/curl ]; then
    CURL_BIN=/data/data/com.termux/files/usr/bin/curl
    CURL_LD_PATH=/data/data/com.termux/files/usr/lib
    if [ -z "$CURL_CACERT" ] && [ -r /data/data/com.termux/files/usr/etc/tls/cert.pem ]; then
      CURL_CACERT=/data/data/com.termux/files/usr/etc/tls/cert.pem
    fi
  elif command -v curl >/dev/null 2>&1; then
    CURL_BIN="$(command -v curl)"
  else
    echo "ERROR: curl binary not found (checked Termux curl and PATH)" >&2
    exit 1
  fi
fi

sanitize_token() {
  printf '%s' "$1" | tr -cd 'A-Za-z0-9._:-'
}

detect_app_version() {
  if [ -n "${KJGX_APP_VERSION:-}" ]; then
    sanitize_token "$KJGX_APP_VERSION"
    return
  fi
  if command -v dumpsys >/dev/null 2>&1; then
    v="$(dumpsys package "$KJGX_PACKAGE" 2>/dev/null | grep 'versionName=' | head -n 1 | sed 's/.*versionName=//' || true)"
    v="$(sanitize_token "$v")"
    if [ -n "$v" ]; then
      printf '%s' "$v"
      return
    fi
  fi
  printf '18.5'
}

detect_bundle_hash() {
  if [ -r "$KJGX_BUNDLE_PATH" ] && command -v sha256sum >/dev/null 2>&1; then
    h="$(sha256sum "$KJGX_BUNDLE_PATH" 2>/dev/null | awk '{print $1}' || true)"
    h="$(sanitize_token "$h")"
    if [ -n "$h" ]; then
      printf '%s' "$h"
      return
    fi
  fi
  if [ -n "${KJGX_BUNDLE_HASH:-}" ]; then
    sanitize_token "$KJGX_BUNDLE_HASH"
    return
  fi
  printf ''
}

http_post() {
  url="$1"
  body="$2"
  if [ -n "$CURL_LD_PATH" ]; then
    if [ -n "$CURL_CACERT" ]; then
      LD_LIBRARY_PATH="$CURL_LD_PATH" "$CURL_BIN" -sS --max-time 20 \
        --cacert "$CURL_CACERT" \
        -H "Authorization: Bearer $CRM_WORKER_TOKEN" \
        -H "Content-Type: application/json" \
        -w '\n__HTTP_CODE:%{http_code}' \
        -X POST -d "$body" "$url" || true
    else
      LD_LIBRARY_PATH="$CURL_LD_PATH" "$CURL_BIN" -sS --max-time 20 \
        -H "Authorization: Bearer $CRM_WORKER_TOKEN" \
        -H "Content-Type: application/json" \
        -w '\n__HTTP_CODE:%{http_code}' \
        -X POST -d "$body" "$url" || true
    fi
  else
    "$CURL_BIN" -sS --max-time 20 \
      -H "Authorization: Bearer $CRM_WORKER_TOKEN" \
      -H "Content-Type: application/json" \
      -w '\n__HTTP_CODE:%{http_code}' \
      -X POST -d "$body" "$url" || true
  fi
}

poll_once() {
  dev_id="$(sanitize_token "$KJGX_DEVICE_ID")"
  app_ver="$(detect_app_version)"
  bhash="$(detect_bundle_hash)"
  if [ -z "$bhash" ]; then
    echo "$(date '+%Y-%m-%dT%H:%M:%S') ERROR: unable to determine RN bundle hash (path=$KJGX_BUNDLE_PATH)" >&2
    return 1
  fi

  exec_ready="false"
  if [ -n "${KJGX_EXEC_CMD:-}" ]; then
    exec_ready="true"
  fi

  if [ -n "${KJGX_EXEC_CMD:-}" ] || [ "$CLAIM_MODE" -eq 1 ]; then
    payload="{\"deviceId\":\"$dev_id\",\"appVersion\":\"$app_ver\",\"bundleHash\":\"$bhash\"}"
    raw="$(http_post "$API_BASE/api/v1/kjgx/worker/claim" "$payload")"
    http_code="$(printf '%s\n' "$raw" | grep '__HTTP_CODE:' | tail -n 1 | cut -d: -f2 || true)"
    resp_body="$(printf '%s\n' "$raw" | grep -v '__HTTP_CODE:' || true)"
    echo "$(date '+%Y-%m-%dT%H:%M:%S') claim http=${http_code:-000} body=$resp_body"

    case "$resp_body" in
      *OTA_HASH_MISMATCH*)
        echo "HALT: L0 OTA bundle hash mismatch detected!" >&2
        return 2
        ;;
    esac
    if [ "${http_code:-000}" = "409" ]; then
      return 2
    fi
    if [ -n "${KJGX_EXEC_CMD:-}" ]; then
      case "$resp_body" in
        *'"job":{'*)
          receipt="$(printf '%s' "$resp_body" | /system/bin/sh -c "$KJGX_EXEC_CMD")"
          job_id="$(printf '%s' "$resp_body" | sed -n 's/.*"job":{[^}]*"id":"\([^"]*\)".*/\1/p')"
          if [ -n "$job_id" ] && [ -n "$receipt" ]; then
            comp_payload="{\"jobId\":\"$job_id\",\"deviceId\":\"$dev_id\",\"receipt\":$receipt}"
            comp_raw="$(http_post "$API_BASE/api/v1/kjgx/worker/complete" "$comp_payload")"
            echo "$(date '+%Y-%m-%dT%H:%M:%S') complete=$comp_raw"
          fi
          ;;
      esac
    fi
    return 0
  fi

  payload="{\"deviceId\":\"$dev_id\",\"appVersion\":\"$app_ver\",\"bundleHash\":\"$bhash\",\"executorReady\":$exec_ready}"
  raw="$(http_post "$API_BASE/api/v1/kjgx/worker/heartbeat" "$payload")"
  http_code="$(printf '%s\n' "$raw" | grep '__HTTP_CODE:' | tail -n 1 | cut -d: -f2 || true)"
  resp_body="$(printf '%s\n' "$raw" | grep -v '__HTTP_CODE:' || true)"
  echo "$(date '+%Y-%m-%dT%H:%M:%S') heartbeat http=${http_code:-000} body=$resp_body"

  case "$resp_body" in
    *'"bundle_hash_matched":false'*)
      echo "WARN: L0 OTA bundle hash mismatch reported by server" >&2
      if [ "$ONCE" -eq 1 ]; then
        return 2
      fi
      ;;
  esac
  if [ "$ONCE" -eq 1 ] && [ "${http_code:-000}" != "200" ]; then
    return 1
  fi
  return 0
}

if [ "$ONCE" -eq 1 ]; then
  poll_once
  exit $?
fi

while true; do
  rc=0
  poll_once || rc=$?
  if [ "$rc" -eq 2 ]; then
    echo "Halting worker loop due to L0 OTA hash mismatch." >&2
    exit 2
  fi
  sleep "$POLL_INTERVAL_SEC"
done
