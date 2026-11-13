#!/usr/bin/env bash
# One-line readiness check for the live sign-in page and the YEET Privy app's dashboard switches.
#
# Prints one line: enabled login methods (same rule as connector/login/login-methods.js), allowed domains, embedded
# wallet create-on-login, funding, the HTTP status of the live login page and whether the page will list at least one
# method. Exit 0 only when at least one social login (Google, Apple, X, Telegram) is on AND the allowed domains include
# the live origin; exit 1 otherwise, 2 when the check itself cannot run.
#
# Only the public app id is needed (the same id the page gets from /account/identity-config); the app secret is never
# read. App id source, first found wins: $PRIVY_APP_ID, the PRIVY_APP_ID line of ~/.secrets/yeet-privy.env (only that
# line is read, nothing is sourced or echoed), the live /account/identity-config.
#
# Usage: ops/check-signin.sh        (env: SIGNIN_ORIGIN, default https://chatgpt.yeet.win)
set -uo pipefail

ORIGIN="${SIGNIN_ORIGIN:-https://chatgpt.yeet.win}"
ENV_FILE="$HOME/.secrets/yeet-privy.env"
UA="yeet-signin-check"

fail() { echo "check-signin: ERROR | $1"; exit 2; }
command -v curl >/dev/null || fail "curl missing"
command -v jq >/dev/null || fail "jq missing"

app_id="${PRIVY_APP_ID:-}"
src="env"
if [ -z "$app_id" ] && [ -r "$ENV_FILE" ]; then
  app_id="$(grep -E '^[[:space:]]*(export[[:space:]]+)?PRIVY_APP_ID=' "$ENV_FILE" | tail -n1 | sed -E 's/^[^=]*=//; s/^["'\'']//; s/["'\'']$//')"
  src="secrets-file"
fi
if [ -z "$app_id" ]; then
  app_id="$(curl -s -m 15 -A "$UA" "$ORIGIN/account/identity-config" | jq -r '.appId // empty' 2>/dev/null)"
  src="identity-config"
fi
[[ "$app_id" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || fail "no usable PRIVY_APP_ID"
masked="${app_id:0:4}…(${#app_id})"

# Public app configuration, as the Privy client fetches it at page load.
cfg="$(curl -s -m 20 -A "$UA" -H "privy-app-id: $app_id" -H "privy-client: react-auth:3.47.0" -H "Origin: $ORIGIN" \
  -w '\n%{http_code}' "https://auth.privy.io/api/v1/apps/$app_id")"
cfg_status="${cfg##*$'\n'}"
cfg="${cfg%$'\n'*}"
[ "$cfg_status" = "200" ] && echo "$cfg" | jq -e 'type=="object"' >/dev/null 2>&1 || fail "privy app config HTTP $cfg_status (app $masked)"

summary="$(echo "$cfg" | jq -r --arg origin "$ORIGIN" '
  def tg_ok: (.telegram_auth == true) and ((.telegram_auth_config.bot_id // "") != "") and ((.telegram_auth_config.bot_name // "") != "");
  . as $c
  | [ (if $c.email_auth == true then "email" else empty end),
      (if $c.google_oauth == true then "google" else empty end),
      (if $c.apple_oauth == true then "apple" else empty end),
      (if $c.twitter_oauth == true then "x" else empty end),
      (if ($c | tg_ok) then "telegram"
       elif $c.telegram_auth == true then "telegram(no-bot-config)" else empty end) ] as $m
  | ($m | map(select(. == "google" or . == "apple" or . == "x" or . == "telegram")) | length) as $social
  | ($m | map(select(test("\\(") | not)) | length) as $shown
  | ($c.allowed_domains // []) as $d
  | ($c.embedded_wallet_config // {}) as $w
  | [ ($social|tostring), ($shown|tostring), (if ($d | index($origin)) then "1" else "0" end),
      "methods=" + (if ($m|length)>0 then ($m|join(",")) else "none" end),
      "domains=" + (if ($d|length)>0 then ($d|join(",")) else "none" end),
      "wallet_on_login=" + ($w.create_on_login // "?") + "(eth=" + ($w.ethereum.create_on_login // "?") + ",sol=" + ($w.solana.create_on_login // "?") + ")",
      "funding=" + (if $c.fiat_on_ramp_enabled == true then "on" else "off" end)
        + (if $c.funding_config then "(" + ([$c.funding_config.funding_methods // $c.funding_config.methods // [] | .[] | tostring] | join(",")) + ")" else "" end)
    ] | join("\t")')" || fail "could not parse app config"
IFS=$'\t' read -r social shown domain_ok f_methods f_domains f_wallet f_funding <<<"$summary"

# Live page: the HTML only mounts #privy-login; the bundle renders the buttons at run time from the config above.
page_status="$(curl -s -m 15 -A "$UA" -o /dev/null -w '%{http_code}' "$ORIGIN/account/login")"
html="$(curl -s -m 15 -A "$UA" "$ORIGIN/account/login")"
mount="no"; [[ "$html" == *'id="privy-login"'* ]] && mount="yes"
bundle="$(curl -s -m 20 -A "$UA" "$ORIGIN/account/privy-login/login.js")"
wired="no"
if [ -n "$bundle" ]; then
  if [[ "$bundle" == *google_oauth* ]]; then wired="yes"; else
    for c in $(grep -oE '"\./chunk-[A-Z0-9]+\.js"' <<<"$bundle" | tr -d '"' | sort -u); do
      if curl -s -m 15 -A "$UA" "$ORIGIN/account/privy-login/${c#./}" | grep -q 'google_oauth'; then wired="yes"; break; fi
    done
  fi
fi
lists="no"; [ "$mount" = yes ] && [ "$wired" = yes ] && [ "$shown" -gt 0 ] && lists="yes"

verdict="FAIL"; code=1
if [ "$social" -gt 0 ] && [ "$domain_ok" = 1 ]; then verdict="OK"; code=0; fi
echo "check-signin: $verdict | app=$masked($src) | $f_methods | $f_domains | $f_wallet | $f_funding | page=$page_status mount=$mount bundle_wired=$wired lists_method=$lists"
exit "$code"
