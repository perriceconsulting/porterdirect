#!/usr/bin/env bash
# Safe .env loader — the ONE place this repo reads a secrets file (DOSI-D).
#
# Why this exists instead of `set -a; . .env.local; set +a`:
#   Sourcing runs the file as SHELL CODE. A single stray space — `KEY= value` — makes
#   the shell assign an empty string and then EXECUTE the value as a command. With a
#   secrets file that means the credential is echoed into the terminal (and into any
#   transcript or CI log) as a "command not found" error, and the script dies with 127.
#   That is a credential-disclosure bug wearing a syntax-error costume; it cost us a
#   key roll once. This parser reads lines as DATA and can never execute a value.
#
# Tolerates and normalizes: surrounding whitespace, `KEY = value`, optional matching
# single/double quotes, `export KEY=value`, CRLF line endings, comments, blank lines.
# Ignores anything that is not a well-formed assignment rather than guessing.

load_env_file() {
  local file="$1" line key val
  [ -f "$file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"                                  # tolerate CRLF
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    case "$line" in *=*) ;; *) continue ;; esac

    key="${line%%=*}"
    val="${line#*=}"

    key="${key%"${key##*[![:space:]]}"}"                   # rtrim name (`KEY = v`)
    key="${key#"${key%%[![:space:]]*}"}"                   # ltrim name
    case "$key" in [A-Za-z_]*) ;; *) continue ;; esac
    case "$key" in *[!A-Za-z0-9_]*) continue ;; esac

    val="${val#"${val%%[![:space:]]*}"}"                   # ltrim value — the bug above
    val="${val%"${val##*[![:space:]]}"}"                   # rtrim value

    # Order matters. A QUOTED value is taken literally: a '#' inside quotes is data
    # (passwords, URL fragments), so it must never be treated as a comment. Only an
    # UNQUOTED value gets its trailing comment stripped — without that, `KEY=   # note`
    # parses as the literal string "# note", an empty setting that reports itself as
    # SET, so a missing-config check passes while the value is garbage.
    case "$val" in
      '"'*'"')
        val="${val:1:${#val}-2}"          # strip the surrounding quotes
        ;;
      "'"*"'")
        val="${val:1:${#val}-2}"          # strip the surrounding quotes
        ;;
      '#'*)
        val=""
        ;;
      *' #'*)
        val="${val%%' #'*}"
        val="${val%"${val##*[![:space:]]}"}"
        ;;
    esac

    export "$key=$val"
  done < "$file"
}
