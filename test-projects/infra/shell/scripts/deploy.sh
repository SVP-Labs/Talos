#!/usr/bin/env bash
set -euo pipefail
target=$1
for f in $(ls "$target"); do
  echo $f
done
