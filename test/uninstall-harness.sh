#!/usr/bin/env bash
set -euo pipefail
uname(){ printf 'Linux\n'; }
flock(){ [[ ${MOCK_LOCK_BUSY:-0} != 1 ]]; }
docker(){
  printf '%s\n' "$*" >> "$MOCK_STATE/docker.log"
  [[ ${MOCK_DAEMON_DOWN:-0} != 1 ]] || { echo 'Cannot connect to Docker daemon' >&2; return 1; }
  case ${1:-} in
    info) return 0 ;;
    context) echo fixture-engine ;;
    ps)
      if [[ -f $MOCK_STATE/container ]]; then echo fixture-yunxiang; fi
      if [[ " $* " == *'label=com.docker.compose.project=newapi-compensation'* && " $* " != *'label=com.docker.compose.service=compensation'* ]]; then echo fixture-newapi; fi
      ;;
    inspect)
      if [[ ${*: -1} == fixture-newapi ]]; then
        echo '/new-api|newapi-compensation|newapi|newapi:latest'
      elif [[ ${MOCK_NAME_COLLISION:-0} == 1 ]]; then
        echo '/yunxiang-compensation|other|database|postgres:latest'
      else
        echo '/yunxiang-compensation|newapi-compensation|compensation|yunxiang-newapi-compensation:local'
      fi
      ;;
    rm)
      [[ ${MOCK_CONTAINER_REMOVE_FAIL:-0} != 1 ]] || return 1
      command rm -f -- "$MOCK_STATE/container"
      if [[ " $* " == *'fixture-newapi'* ]]; then command rm -f -- "$MOCK_STATE/newapi"; fi
      ;;
    volume)
      case ${2:-} in
        ls) [[ ! -f $MOCK_STATE/volume ]] || echo newapi-compensation_compensation_data ;;
        inspect) [[ -f $MOCK_STATE/volume ]] ;;
        rm)
          [[ ${MOCK_VOLUME_REMOVE_FAIL:-0} != 1 ]] || return 1
          command rm -f -- "$MOCK_STATE/volume"
          ;;
        *) echo "unexpected volume operation: $*" >&2; return 93 ;;
      esac
      ;;
    image)
      case ${2:-} in
        ls)
          if [[ " $* " == *'reference=newapi-compensation:local'* ]]; then
            [[ ! -f $MOCK_STATE/legacy-image ]] || echo newapi-compensation:local
          else
            [[ ! -f $MOCK_STATE/image ]] || echo yunxiang-newapi-compensation:local
          fi
          ;;
        inspect) [[ -f $MOCK_STATE/image ]] ;;
        rm)
          [[ ${MOCK_IMAGE_REMOVE_FAIL:-0} != 1 ]] || return 1
          if [[ ${*: -1} == newapi-compensation:local ]]; then
            command rm -f -- "$MOCK_STATE/legacy-image"
          else
            [[ ${MOCK_IMAGE_REMAINS:-0} == 1 ]] || command rm -f -- "$MOCK_STATE/image"
          fi
          ;;
        *) echo "unexpected image operation: $*" >&2; return 94 ;;
      esac
      ;;
    run)
      [[ " $* " == *' newapi-compensation:local '* ]] || return 96
      [[ ${MOCK_LEGACY_NOT_YUNXIANG:-0} != 1 ]]
      ;;
    rmi)
      [[ ${MOCK_IMAGE_REMOVE_FAIL:-0} != 1 ]] || return 1
      [[ ${MOCK_IMAGE_REMAINS:-0} == 1 ]] || command rm -f -- "$MOCK_STATE/image"
      ;;
    compose)
      command rm -f -- "$MOCK_STATE/container" "$MOCK_STATE/volume" "$MOCK_STATE/newapi"
      ;;
    *) echo "unexpected docker call: $*" >&2; return 95 ;;
  esac
}
export -f uname flock docker
if [[ ${MOCK_START_IN_TARGET:-0} == 1 ]]; then cd -- "$YUNXIANG_INSTALL_DIR"; fi
exec bash "$YUNXIANG_UNINSTALL_SCRIPT" "$@"
