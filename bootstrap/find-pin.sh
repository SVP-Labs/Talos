#!/usr/bin/env bash
# Prints the Talos commit that $GITHUB_REPOSITORY's rulesets pin, for workflows that have no
# Talos yet: the lookup src/version/pin.ts does, in bash with gh and jq.
#
#   GITHUB_REPOSITORY  owner/name of the repository (set by Actions)
#   GH_TOKEN           a token that can read its rulesets (metadata: read)
#   TALOS_REPO         the Talos repository, SVP-Labs/Talos by default
#   TALOS_LOOKUP       rulesets (default) or channels
#
# rulesets: the repository's rulesets, the organisation's included (includes_parents=true),
# skipping disabled ones; exactly one may require a workflow from the Talos repository, matched
# by repository id, and its pinned sha is printed.
# channels: the repository's `talos` custom property names a channel, and channels.json on the
# Talos repository's `channels` branch maps it to a commit.
#
# Prints only the SHA. On failure it prints one generic line on stderr and exits 1: messages
# from gh name repositories, which a public log must not show.
set -euo pipefail

repo="${GITHUB_REPOSITORY:-}"
talos="${TALOS_REPO:-SVP-Labs/Talos}"
mode="${TALOS_LOOKUP:-rulesets}"
sha_pattern='^[0-9a-f]{40}$'

fail() {
  echo "find-pin: $1" >&2
  exit 1
}

api() {
  gh api "$@" 2>/dev/null
}

by_rulesets() {
  local talos_id ids id detail shas count=0 pin=""
  talos_id="$(api "repos/$talos" | jq -r '.id')" || fail "cannot read the Talos repository"
  ids="$(api --paginate "repos/$repo/rulesets?includes_parents=true" |
    jq -s -r 'add // [] | .[] | select(.enforcement != "disabled") | .id')" ||
    fail "cannot list the repository's rulesets"
  for id in $ids; do
    detail="$(api "repos/$repo/rulesets/$id?includes_parents=true")" || fail "cannot read a ruleset"
    shas="$(jq -r --argjson talos "$talos_id" '
      [.rules[]? | select(.type == "workflows") | .parameters.workflows[]?
        | select(.repository_id == $talos) | (.sha // "none")] | unique | .[]' <<<"$detail")" ||
      fail "cannot read a ruleset"
    [[ -z "$shas" ]] && continue
    count=$((count + 1))
    [[ "$shas" == *$'\n'* ]] && fail "a ruleset pins Talos at several commits"
    [[ "$shas" =~ $sha_pattern ]] || fail "a ruleset runs Talos at a ref, not a commit SHA"
    pin="$shas"
  done
  [[ "$count" -eq 0 ]] && fail "no ruleset that applies to this repository runs the Talos gate"
  [[ "$count" -gt 1 ]] && fail "$count Talos rulesets apply; exactly one must"
  printf '%s\n' "$pin"
}

by_channels() {
  local channel sha
  channel="$(api "repos/$repo" | jq -r '.custom_properties.talos // empty')" ||
    fail "cannot read the repository"
  case "$channel" in
    evaluate | canary | stable) ;;
    *) fail "the talos property names no channel" ;;
  esac
  sha="$(api "repos/$talos/contents/channels.json?ref=channels" |
    jq -r --arg channel "$channel" '.content | @base64d | fromjson | .[$channel] // empty')" ||
    fail "cannot read channels.json"
  [[ "$sha" =~ $sha_pattern ]] || fail "channels.json has no commit for the channel"
  printf '%s\n' "$sha"
}

[[ -n "$repo" ]] || fail "GITHUB_REPOSITORY is not set"
case "$mode" in
  rulesets) by_rulesets ;;
  channels) by_channels ;;
  *) fail "TALOS_LOOKUP must be rulesets or channels" ;;
esac
