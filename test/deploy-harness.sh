#!/usr/bin/env bash
set -euo pipefail
# Simulate Docker orchestration only; JSON planning still runs real Node code.
uname(){ printf 'Linux\n'; }
flock(){ return 0; }
ss(){ return 0; }
docker(){
  case $1 in
    info) return 0 ;;
    run)
      while [[ $1 != node:24-bookworm-slim ]]; do shift; done
      shift; shift
      "$NODE_EXE" "$@"
      ;;
    compose)
      if [[ " $* " == *' up '* && ${MOCK_BUILD_FAIL:-0} == 1 ]]; then
        echo 'fixture build failure' >&2; return 42
      fi
      if [[ " $* " == *' exec '* ]]; then
        [[ -z ${NEWAPI_URL:-} && -z ${PUBLIC_ORIGIN:-} && -z ${NEWAPI_ADMIN_USER_ID:-} ]] || return 43
        echo 'fixture health/preflight passed'
      fi
      ;;
    *) echo "unexpected docker call: $*" >&2; return 44 ;;
  esac
}
export -f uname flock ss docker
exec bash auto-deploy.sh --non-interactive
