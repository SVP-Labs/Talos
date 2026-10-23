#!/usr/bin/env bash
# Prints a finding for every file whose name has a capital letter, as Talos reads them.
set -euo pipefail
git ls-files | while IFS= read -r file; do
  case "$(basename "$file")" in
    *[A-Z]*)
      printf '{"rule": "file-name", "file": "%s", "line": 1, "message": "File names are lower case."}\n' "$file"
      ;;
  esac
done
