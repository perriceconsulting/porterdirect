#!/usr/bin/env bash
# Conventions a type checker and a linter cannot see, because they live in shell
# scripts and dotfiles. Every check here traces to a defect this repo actually hit.
set -uo pipefail
fail=0
note() { printf '  %s\n' "$1"; }

echo "verify:conventions"

# ---------------------------------------------------------------------------
# 1. Never source a secrets file.
#    `KEY= value` (one stray space) makes a sourcing shell assign an empty string and
#    EXECUTE the value as a command, printing the credential into the terminal and any
#    transcript. It cost this repo a key roll. scripts/lib/load-env.sh parses env files
#    as data instead, and is the only sanctioned reader.
# ---------------------------------------------------------------------------
echo "1) no shell script sources a .env file"
offenders=$(grep -rnE '^[[:space:]]*(\.|source)[[:space:]]+.*\.env' scripts/ 2>/dev/null \
            | grep -v 'scripts/lib/load-env.sh' || true)
if [ -n "$offenders" ]; then
  note "FAIL — a script sources a .env file; use load_env_file from scripts/lib/load-env.sh"
  printf '%s\n' "$offenders" | sed 's/^/     /'
  fail=1
else
  note "ok"
fi

# ---------------------------------------------------------------------------
# 2. Env files use KEY=value with no space after '=' and no inline trailing comment.
#    A space makes the value executable when sourced; an inline comment makes an EMPTY
#    setting parse as the literal string "# note", so a missing-config check passes
#    while the value is garbage. Both happened here.
# ---------------------------------------------------------------------------
echo "2) .env files are KEY=value, no space after '=', no inline comment"
env_bad=0
for f in .env.example .env.local; do
  [ -f "$f" ] || continue
  bad=$(awk -v file="$f" '
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      v = substr($0, index($0,"=")+1)
      if (v ~ /^[[:space:]]/)      printf "%s:%d  space after =\n", file, NR
      else if (v ~ /[[:space:]]#/) printf "%s:%d  inline comment after value\n", file, NR
    }' "$f")
  if [ -n "$bad" ]; then
    note "FAIL — $f"; printf '%s\n' "$bad" | sed 's/^/     /'; env_bad=1; fail=1
  fi
done
[ "$env_bad" -eq 0 ] && note "ok"

# ---------------------------------------------------------------------------
# 3. .env.local must be ignored, and so must every sidecar spelling of it.
#    `*.env.bak` does NOT match `.env.local.bak` — the exact name the standard warns
#    about — which is how a secrets sidecar rides in on `git add -A`.
# ---------------------------------------------------------------------------
echo "3) secrets files and their sidecars are gitignored"
ign_bad=0
for f in .env.local .env.local.bak .env.local.backup .env.production.bak; do
  if ! git check-ignore -q "$f" 2>/dev/null; then
    note "FAIL — $f is NOT gitignored"; ign_bad=1; fail=1
  fi
done
[ "$ign_bad" -eq 0 ] && note "ok"

# ---------------------------------------------------------------------------
# 4. No key material in tracked files.
#    Discriminates real credentials from deliberate fixtures by ENTROPY rather than an
#    allowlist that would rot: Stripe and Neon secrets are random base62 carrying both
#    digits and uppercase letters, while the fixtures here read as lowercase words
#    ("whsec_testsecretfortestingonly"). A fixture that starts looking like a real key
#    is a fixture worth renaming.
#
#    grep finds length-qualified candidates; awk applies the entropy test. Keeping the
#    two in separate tools avoids nested-language escaping — an earlier version embedded
#    Python here, broke on a quote, and still printed "ok". A filter that fails must
#    fail the check, never pass it.
# ---------------------------------------------------------------------------
echo "4) no live-looking key material in tracked files"
candidates=$(git grep -nE '(sk|rk)_(test|live)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|npg_[A-Za-z0-9]{16,}' -- . 2>/dev/null || true)
if [ -n "$candidates" ]; then
  real=$(printf '%s\n' "$candidates" | awk '
    {
      rest = $0
      while (match(rest, /(sk|rk)_(test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|npg_[A-Za-z0-9]+/)) {
        tok = substr(rest, RSTART, RLENGTH)
        sub(/^((sk|rk)_(test|live)_|whsec_|npg_)/, "", tok)
        if (tok ~ /[0-9]/ && tok ~ /[A-Z]/) { print $0; break }
        rest = substr(rest, RSTART + RLENGTH)
      }
    }')
  awk_status=$?
  if [ "$awk_status" -ne 0 ]; then
    note "FAIL — the entropy filter itself errored; refusing to report a pass"
    fail=1
  elif [ -n "$real" ]; then
    note "FAIL — key material appears in tracked files"
    printf '%s\n' "$real" \
      | sed -E 's/(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/\1_\2_<redacted>/g; s/whsec_[A-Za-z0-9]+/whsec_<redacted>/g; s/npg_[A-Za-z0-9]+/npg_<redacted>/g' \
      | sed 's/^/     /'
    fail=1
  else
    note "ok (candidates matched, all low-entropy fixtures)"
  fi
else
  note "ok"
fi

# 5) every read of stored evidence is audited
#
# `presignProofDownloadUnaudited` hands out a URL to a delivery photo, and handing out
# that URL IS the access. Six call sites used to do it with no record of who asked. The
# ordinary path is `openEvidence`, which writes the audit row first and refuses if it
# cannot — so this check exists to stop a seventh unaudited caller appearing quietly.
#
# The allowlist is deliberately tiny and each entry has a reason:
#   lib/storage.ts            declares it
#   lib/access-log.ts         wraps it — this is the audited path
#   the two proof.pdf routes  assemble ONE document from two objects and log once, so
#                             logging each fetch would describe our plumbing rather than
#                             the reader's behaviour
note "5) reads of stored evidence go through the audited path"
unaudited=$(git grep -ln 'presignProofDownloadUnaudited' -- 'apps/**/*.ts' 'apps/**/*.tsx' 2>/dev/null   | grep -v -e 'apps/marketing/lib/storage.ts'             -e 'apps/marketing/lib/access-log.ts'             -e 'proof.pdf/route.ts'             -e 'apps/marketing/test/storage.test.ts' || true)
if [ -n "$unaudited" ]; then
  note "FAIL — unaudited evidence reads outside the allowlist:"
  printf '%s
' "$unaudited" | sed 's/^/     /'
  note "     use openEvidence() from lib/access-log.ts instead"
  fail=1
else
  note "ok"
fi

# 6) every workspace package an app imports is declared as its dependency
#
# npm workspaces hoist, so an undeclared `@porterdirect/*` import resolves perfectly on a
# machine where some OTHER package already pulled it in — typecheck passes, tests pass,
# lint passes — and then a clean install on a build server has no reason to create the
# symlink. That is exactly how `@porterdirect/pricing` reached production as
# "Module not found" after a fully green local run.
note "6) apps declare every workspace package they import"
undeclared=""
for appdir in apps/*/; do
  [ -f "$appdir/package.json" ] || continue
  imported=$(git grep -ho '@porterdirect/[a-z-]*' -- "$appdir" 2>/dev/null | sort -u)
  for pkg in $imported; do
    if ! grep -q "\"$pkg\"" "$appdir/package.json"; then
      undeclared="$undeclared
     $appdir needs $pkg"
    fi
  done
done
if [ -n "$undeclared" ]; then
  note "FAIL — workspace imports missing from package.json:"
  printf "%b
" "$undeclared"
  fail=1
else
  note "ok"
fi

if [ "$fail" -ne 0 ]; then echo "verify:conventions FAILED"; exit 1; fi
echo "verify:conventions passed"
