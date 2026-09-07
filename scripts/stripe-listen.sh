#!/usr/bin/env bash
# Forward Stripe webhooks to the local app.
#
# The CLI stores its OWN auth, independent of .env.local (CLAUDE.md: "the provider CLI
# is a second source of truth"). The classic failure is `stripe listen` sitting there
# forwarding nothing because it watches a different account than the app's keys —
# silence looks exactly like "no events yet". So: pin the account per invocation when
# a key is available, and when it is not, say loudly which account is actually watched.
#
# This script NEVER prints key material.
set -euo pipefail

PORT="${PORT:-3000}"
ENDPOINT="localhost:${PORT}/api/stripe/webhook"
ENV_FILE=".env.local"

HERE="$(cd "$(dirname "$0")" && pwd)"
# NEVER source a secrets file: `KEY= value` would execute the value (and print it).
. "$HERE/lib/load-env.sh"
load_env_file "$ENV_FILE"

SK="${STRIPE_SECRET_KEY:-}"
CLI_ACCT="$(stripe config --list 2>/dev/null | sed -nE "s/^account_id[[:space:]]*=[[:space:]]*'?([^']*)'?/\1/p" | head -1)"

if [ -n "$SK" ]; then
  case "$SK" in
    sk_test_*|rk_test_*) ;;
    *) echo "REFUSING: STRIPE_SECRET_KEY is not a test key (prefix=${SK:0:8}…)." >&2; exit 1 ;;
  esac
  echo "stripe:listen — pinning the account via --api-key (prefix=${SK:0:8}…, len=${#SK})."
  echo "stripe:listen — forwarding to ${ENDPOINT}"
  exec stripe listen --api-key "$SK" --forward-to "$ENDPOINT" "$@"
fi

cat >&2 <<WARN
stripe:listen — WARNING: STRIPE_SECRET_KEY is not set in ${ENV_FILE}.
  Falling back to the Stripe CLI's own stored login, which is a SEPARATE source of
  truth from this app's keys. Events fired against a different account will be
  silently missed — the listener will just sit there.
  CLI account: ${CLI_ACCT:-<unknown>}
  Confirm that is the account you intend, or set STRIPE_SECRET_KEY and re-run.
WARN
echo "stripe:listen — forwarding to ${ENDPOINT}"
exec stripe listen --forward-to "$ENDPOINT" "$@"
