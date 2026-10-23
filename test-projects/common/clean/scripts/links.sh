#!/usr/bin/env bash
# Prints a finding for each Markdown link to a file that does not exist, and exits 1 when any.
set -euo pipefail
status=0
while IFS=: read -r file line target; do
  if [[ ! -e "$(dirname "$file")/$target" ]]; then
    printf '{"rule": "dead-link", "file": "%s", "line": %s, "message": "%s does not exist."}\n' \
      "$file" "$line" "$target"
    status=1
  fi
done < <(grep -no '](\./[^)]*)' docs/*.md | sed -E 's/\]\((.*)\)$/\1/')
exit "$status"
