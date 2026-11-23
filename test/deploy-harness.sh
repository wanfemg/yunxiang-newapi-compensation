#!/usr/bin/env bash
set -euo pipefail
# Simulate Docker orchestration only; JSON planning still runs real Node code.
uname(){ printf 'Linux\n'; }
flock(){ return 0; }
ss(){ return 0; }
docker(){
  if [[ -n ${MOCK_DOCKER_LOG:-} ]]; then printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"; fi
  local docker_verb=$1
  case $docker_verb in
    info) return 0 ;;
    context) echo default ;;
    image)
      if [[ $2 == inspect && ${MOCK_IMAGE_MISSING:-0} == 1 ]]; then return 1; fi
      if [[ $2 == rmi ]]; then echo "mock image removed: $*"; return 0; fi
      echo 'fixture image exists'
      ;;
    volume)
      if [[ $2 == inspect ]]; then
        if [[ ${MOCK_VOLUME_MISSING:-0} == 1 ]]; then return 1; fi
        echo 'fixture volume exists'
      elif [[ $2 == rm ]]; then
        MOCK_VOLUME_MISSING=1
        echo "mock volume removed: $*"
      fi
      ;;
    volume-after-recovery)
      echo 'fixture volume restored'
      ;;
    run)
      local full_args=("$@") mount_source='' mount_destination='' prev=''
      for arg in "${full_args[@]}"; do
        if [[ $prev == -v && $arg == *:/restore:ro ]]; then mount_source=${arg%:/restore:ro}; fi
        if [[ $prev == -v && $arg == *:/data:rw ]]; then mount_destination=${arg%:/data:rw}; fi
        prev=$arg
      done
      while [[ $1 != node:24-bookworm-slim ]]; do shift; done
      shift; shift
      if [[ -n $mount_source && -n $mount_destination ]]; then
        mkdir -p "$mount_destination"
        if [[ -f $mount_source/compensation.sqlite && " $* " == *" chown "* ]]; then
          cp -- "$mount_source/compensation.sqlite" "$mount_destination/compensation.sqlite"
          for name in compensation.sqlite-wal compensation.sqlite-shm secrets.key dingtalk.enc; do
            [[ -f $mount_source/$name ]] && cp -- "$mount_source/$name" "$mount_destination/$name"
          done
        fi
        chmod 700 "$mount_destination" 2>/dev/null || true
        MOCK_VOLUME_MISSING=''
      else
        if [[ " $* " == *" chown "* ]]; then return 0; fi
        "$NODE_EXE" "$@"
      fi
      ;;
    cp) return 1 ;;
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
    network)
      if [[ $2 == inspect ]]; then
        if [[ -n ${MOCK_NETWORK_MISSING:-} && $3 == "$MOCK_NETWORK_MISSING" ]]; then return 1; fi
        echo bridge
      fi
      ;;
    ps)
      if [[ $2 == -aq ]]; then
        if [[ ${MOCK_UNINSTALL_CONTAINERS:-0} == 1 && ( " $* " == *'name=^/yunxiang-compensation$'* || " $* " == *'label=com.docker.compose.project=newapi-compensation'* ) ]]; then
          echo mock-yunxiang-container
        fi
      fi
      return 0
      ;;
    rm)
      MOCK_UNINSTALL_CONTAINERS=''
      echo "mock removed: $*"
      ;;
    rmi)
      echo "mock image removed: $*"
      ;;
    inspect)
      return 1
      ;;
    *) echo "unexpected docker call: $*" >&2; return 44 ;;
  esac
}
export -f uname flock ss docker
curl(){ local output=''; while (($# > 0)); do if [[ $1 == -o ]]; then output=$2; fi; shift; done; [[ -n $output ]] || return 1; cp "$ARCHIVE" "$output"; }
export -f curl
if [[ -n ${YUNXIANG_INSTALLER:-} ]]; then
  source "$YUNXIANG_INSTALLER" < "$YUNXIANG_ANSWER"
  exit $?
fi
if [[ ${1:-} == uninstall.sh || ${1:-} == --uninstall ]]; then
  shift
  if [[ -n ${MOCK_UNATTEND:-} ]]; then set -- --yes; fi
  exec bash "${BASH_SOURCE[0]%/*}/../uninstall.sh" "$@"
fi
if (($# == 0)); then
  if [[ -n ${YUNXIANG_TEST_PROMPTS:-} ]]; then
    exec bash auto-deploy.sh "$@"
  fi
  exec bash auto-deploy.sh --non-interactive
fi
if [[ -n ${YUNXIANG_TEST_PROMPTS:-} ]]; then
  exec bash auto-deploy.sh "$@"
fi
exec bash auto-deploy.sh --non-interactive "$@"
