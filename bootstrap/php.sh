#!/usr/bin/env bash
# Says which runs need PHP, and which PHP, for the workflows that set it up before Talos runs:
# the PHP checks run the project's own toolchain, which needs PHP with pcov and composer on the
# runner. Run it inside the repository's checkout, naming the commits whose talos.yml counts:
#
#   php.sh <commit>...
#
# A PHP component in talos.yml at any of the commits needs PHP on each OS it lists (linux when it
# lists none). The version is the newest minor that any of their composer.json files asks for
# (config.platform.php, else require.php), and never older than 8.4, the oldest PHP the toolchain
# installs on. Prints two lines for $GITHUB_OUTPUT:
#
#   oses=["linux"]
#   version=8.4
#
# Needs git, jq and yq (mikefarah's, which GitHub's runners carry, or the Python one).
set -euo pipefail

floor='8.4'
php_components='[.components[]? | select(.lang == "php")
  | {root: ((.root // ".") | sub("/+$"; "") | sub("^\\./"; "") | if . == "" then "." else . end),
     os: (.os // ["linux"])}]'
minor_asked='(.config.platform.php // .require.php // "") | tostring
  | [scan("[0-9]+\\.[0-9]+")] | .[0] // empty'

fail() {
  echo "php: $1" >&2
  exit 1
}

(($# > 0)) || fail "name the commits whose talos.yml counts"
command -v yq >/dev/null || fail "yq is not on PATH"

oses=''
versions="$floor"
for commit in "$@"; do
  config="$(git show "$commit:talos.yml" 2>/dev/null)" || continue
  json="$(yq -o=json '.' <<<"$config" 2>/dev/null || yq '.' <<<"$config" 2>/dev/null)" ||
    fail "talos.yml at $commit is not YAML"
  php="$(jq -c "$php_components" <<<"$json" 2>/dev/null)" ||
    fail "cannot read the components of talos.yml at $commit"
  oses+="$(jq -r '.[].os[]' <<<"$php")"$'\n'
  roots="$(jq -r '.[].root' <<<"$php")"
  while IFS= read -r root; do
    [[ -n "$root" ]] || continue
    file="$root/composer.json"
    [[ "$root" == "." ]] && file='composer.json'
    composer="$(git show "$commit:$file" 2>/dev/null)" || continue
    versions+=$'\n'"$(jq -r "$minor_asked" <<<"$composer" 2>/dev/null || true)"
  done <<<"$roots"
done

version="$({ grep -E '^[0-9]+\.[0-9]+$' <<<"$versions" || true; } | sort -V | tail -n 1)"
list="$({ grep -E '^(linux|windows|macos)$' <<<"$oses" || true; } | sort -u | jq -R . | jq -cs .)"
printf 'oses=%s\nversion=%s\n' "$list" "$version"
