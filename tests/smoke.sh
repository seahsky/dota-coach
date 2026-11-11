#!/usr/bin/env bash
# Runs every tool once against the live APIs and checks error paths.
# Usage: bash tests/smoke.sh   (from the skill directory)
set -u
cd "$(dirname "$0")/.."

pass=0
fail=0
run() {
  local expect=$1; shift
  local out
  out=$("$@" 2>&1)
  local code=$?
  if { [ "$expect" = ok ] && [ $code -eq 0 ]; } || { [ "$expect" = err ] && [ $code -eq 1 ] && ! grep -q "    at " <<<"$out"; }; then
    pass=$((pass + 1)); printf 'PASS  %s\n' "$*"
  else
    fail=$((fail + 1)); printf 'FAIL  %s (exit %s)\n%s\n' "$*" "$code" "$(head -5 <<<"$out")"
  fi
}

match_id=$(bun -e 'const r=await fetch("https://api.opendota.com/api/proMatches");const j=await r.json();console.log(j[0]?.match_id??"")')

run ok  bun run tools/GetPatch.ts
run ok  bun run tools/GetHero.ts am
run ok  bun run tools/GetHeroStats.ts --top=5
run ok  bun run tools/GetMatchups.ts pudge
run ok  bun run tools/GetItemBuilds.ts qop
if [ -n "$match_id" ]; then
  run ok bun run tools/GetMatch.ts "$match_id" --draft
  run ok bun run tools/ReplayMap.ts "$match_id" --json
else
  echo "SKIP  GetMatch (could not fetch a recent pro match id)"
fi
run ok  bun run tools/GetHero.ts wr --json
run ok  env STRATZ_API_KEY= bun run tools/GetMatchups.ts es

export DOTACOACH_PROFILE=$(mktemp -d)/profile.json
run ok  bun run tools/Profile.ts
run ok  bun run tools/Profile.ts set-main https://www.opendota.com/players/86745912
run ok  bun run tools/LastMatch.ts --count=2
run ok  bun run tools/WatchMatches.ts --print-gsi-config
run err bun run tools/Profile.ts add-alt https://steamcommunity.com/id/someone
run err bun run tools/Profile.ts add-alt notanid
run err bun run tools/WatchMatches.ts --test=abc --no-parse --no-review
unset DOTACOACH_PROFILE

run err bun run tools/GetHero.ts xyzzy
run err bun run tools/GetHero.ts shadow
run err bun run tools/GetMatch.ts 1
run err bun run tools/GetMatch.ts abc
run err bun run tools/ReplayMap.ts abc
run err bun run tools/ReplayMap.ts 1 --save-markers='[{"kind":"nope","x":100,"y":100,"label":"x"}]'
run err bun run tools/GetPatch.ts --version=9.99
run err bun run tools/GetHeroStats.ts --bracket=mythic

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
