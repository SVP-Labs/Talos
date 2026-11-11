#!/usr/bin/env bash
# Writes a module the crate needs, so it compiles only when this script ran.
set -euo pipefail
printf '//! Written by the setup script.\n\npub const STEP: u32 = 1;\n' > src/generated.rs
