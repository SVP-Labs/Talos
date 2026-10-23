#!/usr/bin/env bash
set -euo pipefail

main() {
  local name="${1:-world}"
  printf 'hello %s\n' "${name}"
}

main "$@"
