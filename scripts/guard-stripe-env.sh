#!/usr/bin/env bash
# Mechanical refusal: never let a LIVE Stripe key run in a dev/test context.
# Live and test keys sit side by side and differ by four characters (CLAUDE.md).
# Sourced value is read from the environment; this script NEVER prints the value.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Load .env.local when the caller has not already exported the key, otherwise the
# guard silently reports "not set" and passes — a green that checked nothing.
# Never `.` a secrets file: `KEY= value` executes the value. See lib/load-env.sh.
if [ -z "${STRIPE_SECRET_KEY:-}" ]; then
  . "$HERE/lib/load-env.sh"
  load_env_file "${ENV_FILE:-.env.local}"
fi

SK="${STRIPE_SECRET_KEY:-}"

if [ -z "$SK" ]; then
  echo "guard:stripe — STRIPE_SECRET_KEY is not set (nothing to check)."
  exit 0
fi

case "$SK" in
  sk_test_*|rk_test_*)
    # Read back name/length/prefix only — never the value.
    echo "guard:stripe — OK: test-mode key detected (len=${#SK}, prefix=${SK:0:8}…)."
    ;;
  *)
    echo "guard:stripe — REFUSING: STRIPE_SECRET_KEY is not a test key (prefix=${SK:0:8}…)." >&2
    echo "Dev/test must use sk_test_ / rk_test_ keys only." >&2
    exit 1
    ;;
esac
