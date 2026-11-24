#!/usr/bin/env bash
set -euo pipefail
# Only Docker is simulated; deployment scripts and helper commands execute unchanged.
uname(){ printf 'Linux\n'; }
flock(){ [[ ${MOCK_LOCK_FAIL:-0} != 1 ]]; }
ss(){ [[ ${MOCK_PORT_BUSY:-0} != 1 ]] || printf 'LISTEN 0 128 127.0.0.1:3210\n'; }
docker(){ "$NODE_EXE" -- "$YUNXIANG_DOCKER_CLI" "$@"; }
curl(){
  local output='' url='' previous=''
  for argument in "$@"; do
    [[ $previous != -o ]] || output=$argument
    [[ $argument != https://* ]] || url=$argument
    previous=$argument
  done
  printf '%s\n' "$url" >> "$YUNXIANG_DOCKER_STATE/downloads.log"
  [[ ${MOCK_DOWNLOAD_FAIL:-0} != 1 ]] || return 22
  if [[ $url == */uninstall.sh || $url == */deploy-runtime.sh ]]; then
    local filename=${url##*/}
    if [[ -n $output ]]; then cp -- "$YUNXIANG_FIXTURE_SOURCE/$filename" "$output"; else cat -- "$YUNXIANG_FIXTURE_SOURCE/$filename"; fi
  else
    [[ -n $output && -n ${ARCHIVE:-} ]] || return 23
    cp -- "$ARCHIVE" "$output"
  fi
}
export -f uname flock ss docker curl
if [[ -n ${YUNXIANG_ANSWER:-} ]]; then
  exec 3< "$YUNXIANG_ANSWER"
fi
cd -- "$YUNXIANG_TEST_WORKDIR"
if [[ ${YUNXIANG_TEST_PIPE:-0} == 1 ]]; then
  cat -- "$YUNXIANG_TEST_ENTRY" | bash -s -- "$@" 2>&1
  exit $?
fi
exec bash "$YUNXIANG_TEST_ENTRY" "$@" 2>&1
