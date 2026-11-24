#!/usr/bin/env bash
set -euo pipefail
uname(){ printf 'Linux\n'; }
flock(){ return 0; }
docker(){ MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' "$NODE_EXE" "$MIGRATION_DOCKER" "$@"; }
export -f uname flock docker
exec bash "$MIGRATION_SCRIPT" "$@"
