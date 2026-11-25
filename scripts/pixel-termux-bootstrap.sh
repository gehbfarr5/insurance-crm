#!/usr/bin/env bash
set -euo pipefail

# Zero-PII Pixel 3a Termux bootstrap & KJGX worker helper.
# Modes:
#   --check        Inspect UID, sshd, Tailscale, KJGX package, RN bundle SHA-256, and CRM /health
#   --worker       Run scripts/kjgx-worker.mjs over HTTPS (requires CRM_API_URL, CRM_WORKER_TOKEN, KJGX_BUNDLE_HASH)
#   --reverse-ssh  Open a persistent -R reverse SSH tunnel to Seoul :22 (requires SEOUL_SSH_TARGET)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/pixel-termux-bootstrap.sh --check
  CRM_API_URL=https://<host>:<port>/crm CRM_WORKER_TOKEN=<tok> KJGX_BUNDLE_HASH=<sha256> scripts/pixel-termux-bootstrap.sh --worker [--once] [--dry-run]
  SEOUL_SSH_TARGET=ubuntu@<seoul-tailscale-ip> [REVERSE_PORT=18022] [LOCAL_SSHD_PORT=8022] scripts/pixel-termux-bootstrap.sh --reverse-ssh
EOF
}

case "$MODE" in
  --check)
    echo "=== Pixel Termux Identity ==="
    id
    echo "=== SSHD Check ==="
    (ss -tlnp 2>/dev/null || netstat -tln 2>/dev/null || pgrep -af sshd || echo "sshd not detected") | grep -E "8022|sshd" || true
    echo "=== Tailscale Check ==="
    if command -v tailscale >/dev/null 2>&1; then
      tailscale status --peers=false 2>/dev/null || tailscale status 2>/dev/null || true
    else
      echo "tailscale CLI unavailable in Termux PATH (check Android Tailscale app)"
    fi
    echo "=== KJGX App Version ==="
    if command -v pm >/dev/null 2>&1; then
      pm list packages com.cpic.kjgxplus 2>/dev/null || true
    fi
    if command -v dumpsys >/dev/null 2>&1; then
      (dumpsys package com.cpic.kjgxplus 2>/dev/null | grep -E "versionCode|versionName" | head -n 5) || true
    fi
    if [[ -n "${KJGX_BUNDLE_PATH:-}" ]]; then
      echo "=== RN Bundle SHA-256 ==="
      if [[ -r "$KJGX_BUNDLE_PATH" ]]; then
        sha256sum "$KJGX_BUNDLE_PATH"
      else
        echo "Unreadable KJGX_BUNDLE_PATH=$KJGX_BUNDLE_PATH (may need root/su inside local Termux shell)"
      fi
    fi
    if [[ -n "${CRM_API_URL:-}" ]]; then
      echo "=== CRM HTTPS Health ==="
      curl -fsS --max-time 10 "${CRM_API_URL%/}/health" && echo
    fi
    ;;

  --worker)
    shift
    : "${CRM_API_URL:?CRM_API_URL is required (e.g. https://<host>:<port>/crm)}"
    : "${CRM_WORKER_TOKEN:?CRM_WORKER_TOKEN is required (pixel3a-kjgx Bearer key)}"
    if command -v node >/dev/null 2>&1; then
      : "${KJGX_BUNDLE_HASH:?KJGX_BUNDLE_HASH is required for kjgx-worker.mjs}"
      exec node "$REPO_ROOT/scripts/kjgx-worker.mjs" "$@"
    fi
    exec sh "$REPO_ROOT/scripts/kjgx-worker.sh" "$@"
    ;;

  --reverse-ssh)
    : "${SEOUL_SSH_TARGET:?SEOUL_SSH_TARGET is required (e.g. ubuntu@<seoul-tailscale-ip>)}"
    REVERSE_PORT="${REVERSE_PORT:-18022}"
    LOCAL_SSHD_PORT="${LOCAL_SSHD_PORT:-8022}"
    exec ssh -N \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -R "127.0.0.1:${REVERSE_PORT}:127.0.0.1:${LOCAL_SSHD_PORT}" \
      "$SEOUL_SSH_TARGET"
    ;;

  *)
    usage >&2
    exit 1
    ;;
esac
