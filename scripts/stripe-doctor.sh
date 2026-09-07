#!/usr/bin/env bash
# PorterDirect Stripe dev-setup doctor.
#
# Instantiates the global CLAUDE.md "Third-party sandboxes and client accounts" checklist
# for this repo: verify the credential SET (secret + publishable + webhook secret, all
# test-mode, one account), then ASSERT the account via whoami so a key that merely "works"
# isn't mistaken for the intended account. NEVER prints a secret value — only names,
# lengths, and short prefixes. The account id (acct_…) is an identifier, not a secret.
#
# Usage: bash scripts/stripe-doctor.sh [env-file]   (default: .env.local)
set -uo pipefail

ENV_FILE="${1:-.env.local}"
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0

mask() {
  local v="${1:-}"
  if [ -z "$v" ]; then echo "MISSING"; else echo "set (len=${#v}, prefix=${v:0:8}…)"; fi
}

if [ -f "$ENV_FILE" ]; then
  # NEVER source a secrets file: `KEY= value` would execute the value. See lib/load-env.sh.
  . "$HERE/lib/load-env.sh"
  load_env_file "$ENV_FILE"
  echo "Loaded $ENV_FILE"
else
  echo "No $ENV_FILE — reading from the current environment (copy .env.example → .env.local)."
fi

SK="${STRIPE_SECRET_KEY:-}"
PK="${STRIPE_PUBLISHABLE_KEY:-}"
WH="${STRIPE_WEBHOOK_SECRET:-}"

echo
echo "1) Credential set (names/lengths/prefixes only — never values):"
echo "   STRIPE_SECRET_KEY:      $(mask "$SK")"
echo "   STRIPE_PUBLISHABLE_KEY: $(mask "$PK")"
echo "   STRIPE_WEBHOOK_SECRET:  $(mask "$WH")"

echo
echo "2) Test-mode + prefix guards:"
STRIPE_SECRET_KEY="$SK" bash "$HERE/guard-stripe-env.sh" || fail=1
case "$PK" in
  pk_test_*) echo "guard:pk — OK: test-mode publishable key." ;;
  "")        echo "guard:pk — MISSING publishable key." >&2; fail=1 ;;
  *)         echo "guard:pk — REFUSING: publishable key is not pk_test_ (prefix=${PK:0:8}…)." >&2; fail=1 ;;
esac
case "$WH" in
  whsec_*) echo "guard:whsec — OK: webhook signing secret present." ;;
  "")      echo "guard:whsec — MISSING (re-derive PER ACCOUNT; never carry over)." >&2; fail=1 ;;
  *)       echo "guard:whsec — unexpected prefix (${WH:0:8}…)." >&2; fail=1 ;;
esac

echo
echo "3) Assert the account (whoami) — confirm it is the intended PorterDirect account:"
if [ -n "$SK" ] && command -v curl >/dev/null 2>&1; then
  acct="$(curl -s https://api.stripe.com/v1/account -u "$SK:" \
    | grep -o '"id"[[:space:]]*:[[:space:]]*"acct_[^"]*"' | head -1 | grep -o 'acct_[^"]*' || true)"
  if [ -n "$acct" ]; then
    echo "   Authenticated as: $acct   ← is this the account you meant?"
  else
    echo "   Could not read an account id (key rejected, or no network)." >&2
    fail=1
  fi
else
  echo "   Skipped (no secret key set, or curl unavailable)."
fi

echo
if [ "$fail" -eq 0 ]; then
  cat <<'NEXT'
Doctor: the credential set is consistent and the account is assertable. Remaining checklist:
  4) Update provenance comments beside the keys you just set (a stale comment is a lie).
  5) Point the Stripe CLI at THIS account and forward to the app webhook:
       stripe listen --api-key "$STRIPE_SECRET_KEY" \
         --forward-to localhost:3000/api/stripe/webhook
  6) Exercise ONE real call through the app (create a test subscription) — not the dashboard.
See docs/stripe-dev-setup.md for the full walkthrough.
NEXT
else
  echo "Doctor: fix the issues above before wiring Stripe. See docs/stripe-dev-setup.md." >&2
fi
exit "$fail"
