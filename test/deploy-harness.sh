#!/usr/bin/env bash
set -euo pipefail
# Simulate Docker orchestration only; JSON planning still runs real Node code.
uname(){ printf 'Linux\n'; }
flock(){ return 0; }
ss(){ return 0; }
docker(){
  case $1 in
    info) return 0 ;;
    context) echo default ;;
    image) echo 'fixture image exists' ;;
    run)
      while [[ $1 != node:24-bookworm-slim ]]; do shift; done
      shift; shift
      "$NODE_EXE" "$@"
      ;;
    compose)
      if [[ " $* " == *' config '* && " $* " != *' --quiet '* ]]; then
        "$NODE_EXE" --input-type=module -e 'import fs from "node:fs";import path from "node:path";const p=JSON.parse(fs.readFileSync("compose.generated.json","utf8"));p.services.compensation.build.context=process.cwd();for(const s of Object.values(p.secrets))s.file=path.resolve(s.file);console.log(JSON.stringify(p));'
      fi
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
