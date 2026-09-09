#!/usr/bin/env bash
# Push the runtime environment to a Vercel target.
#
#   bash scripts/vercel-env-push.sh production https://your-deployment-url
#
# Reads .env.local through the ONE sanctioned parser (scripts/lib/load-env.sh) and never
# prints a value — only names and outcomes. A transcript outlives every key in it.
#
# The allowlist is deliberate. Copying a whole .env file to a hosted environment is how
# a local-only test seam ends up weakening production, and how a webhook secret that
# belongs to one endpoint ends up silently failing verification on another.
set -euo pipefail

TARGET="${1:-production}"
PUBLIC_URL="${2:-}"

cd "$(dirname "$0")/.."
. scripts/lib/load-env.sh
load_env_file .env.local

VERCEL="./node_modules/.bin/vercel"

# Copied verbatim from .env.local.
COPY=(
  DATABASE_URL
  BETTER_AUTH_SECRET
  STRIPE_SECRET_KEY
  STRIPE_PUBLISHABLE_KEY
  STRIPE_AUTOMATIC_TAX
  STRIPE_PRICE_DIRECT_COURIER
  STRIPE_PRICE_FLEET_FREIGHT
  STRIPE_PRICE_WHITE_LABEL_AGENCY
  STRIPE_PRICE_SETUP_FEE_AGENCY
  STRIPE_PRICE_APP_STORE_DEPLOY
  PASSWORD_POLICY
  PASSWORD_BREACH_CHECK
  RESEND_API_KEY
  EMAIL_FROM
)

# NEVER copied, each for a specific reason:
#
#   STRIPE_WEBHOOK_SECRET  Per ACCOUNT *and* per ENDPOINT. The local value was derived by
#                          `stripe listen` for a localhost forwarder; on a deployed URL it
#                          fails signature verification, and that surfaces as 400s in a log
#                          nobody reads rather than as a visibly broken checkout. Re-derive
#                          it from a real Stripe webhook endpoint pointed at the deployment.
#   PASSWORD_BREACH_SOURCE A TEST seam. The app throws if it is "fixture" in production, by
#                          design — but the right handling is not to send it at all.
#   VERCEL_OIDC_TOKEN      Written into .env.local by `vercel link`; the platform manages it.
SKIP=(STRIPE_WEBHOOK_SECRET PASSWORD_BREACH_SOURCE VERCEL_OIDC_TOKEN)

put() {
  local key="$1" val="$2"
  # Replace rather than fail when it already exists, so this script is re-runnable.
  $VERCEL env rm "$key" "$TARGET" --yes >/dev/null 2>&1 || true
  if printf '%s' "$val" | $VERCEL env add "$key" "$TARGET" >/dev/null 2>&1; then
    printf '  %-34s set (%d chars)\n' "$key" "${#val}"
  else
    printf '  %-34s FAILED\n' "$key"
  fi
}

echo "target: $TARGET"
echo

for key in "${COPY[@]}"; do
  val="${!key-}"
  if [ -z "$val" ]; then
    printf '  %-34s skipped (empty in .env.local)\n' "$key"
    continue
  fi
  put "$key" "$val"
done

# BETTER_AUTH_URL must be the DEPLOYED origin, not the local one. Copying it verbatim
# sets a production instance's public origin to http://localhost:3000, which breaks every
# auth callback and email link while the app otherwise boots and looks healthy.
if [ -n "$PUBLIC_URL" ]; then
  put BETTER_AUTH_URL "$PUBLIC_URL"
else
  echo "  BETTER_AUTH_URL                    NOT SET — pass the deployment URL as arg 2"
fi

echo
echo "deliberately not sent:"
for key in "${SKIP[@]}"; do printf '  %s\n' "$key"; done
