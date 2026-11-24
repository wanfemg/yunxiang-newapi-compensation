#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  printf '%s\n' \
    '云响跨服务器迁移：bash migrate.sh export|import /tmp/yunxiang-migration.tar.gz' \
    '导出会短暂停止云响写入，完成或失败后恢复原来运行的容器。' \
    '导入拒绝覆盖现有部署配置、容器或账本卷；完成后运行 bash install.sh。'
}
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
[[ $# == 2 && ${1:-} =~ ^(export|import)$ ]] || { usage; exit 1; }
[[ -n $2 && $2 != */ ]] || { echo '迁移包路径无效。'; exit 1; }
action=$1
archive=$(realpath -m -- "$2")
project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd -- "$project"
[[ -f $project/deploy-runtime.sh ]] || { echo '缺少 deploy-runtime.sh，先更新完整云响源码。'; exit 1; }
source "$project/deploy-runtime.sh"
[[ $(uname -s) == Linux ]] || { echo '迁移工具用于 Linux 服务器。'; exit 1; }
for command in docker tar flock; do command -v "$command" >/dev/null || { echo "需要 $command。"; exit 1; }; done
docker info >/dev/null
yx_acquire_lock "$project"

volume=newapi-compensation_compensation_data
helper=node:24-bookworm-slim
temp=''
archive_pending=''
created_volume=0
restart_containers=()
cleanup() {
  local result=$? restart_failed=0
  trap - EXIT
  for container in "${restart_containers[@]}"; do
    if ! docker start "$container" >/dev/null; then
      echo "云响容器恢复运行失败：$container；执行 docker start $container。" >&2
      restart_failed=1
    fi
  done
  [[ -z $archive_pending || ! -f $archive_pending ]] || rm -f -- "$archive_pending"
  [[ -z $temp || ! -d $temp ]] || rm -rf -- "$temp"
  if (( result != 0 && created_volume )); then
    echo '迁移导入未完成，已保留本次创建的数据卷和源迁移包；核查后重试，不会覆盖其他账本。' >&2
  fi
  if (( result != 0 || restart_failed )); then
    echo '迁移未成功；未删除源账本。' >&2
    exit 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! docker image inspect "$helper" >/dev/null 2>&1; then docker pull "$helper"; fi
run_helper() {
  docker run --rm -i --network none --read-only --user 0:0 \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges --tmpfs /tmp \
    -v "$project/src:/app/src:ro" "$@" "$helper" node --input-type=module -
}

if [[ $action == export ]]; then
  [[ ! -e $archive && ! -L $archive ]] || { echo "目标文件已存在：$archive"; exit 1; }
  [[ -d $(dirname -- "$archive") ]] || { echo '迁移包目标目录不存在。'; exit 1; }
  [[ ! -L secrets && ! -L src ]] || { echo '部署源码和 secrets 目录不能是符号链接。'; exit 1; }
  for file in .env.auto compose.generated.json secrets/newapi_admin_token secrets/newapi_database.json; do
    [[ -s $file && -f $file && ! -L $file ]] || { echo "缺少有效 $file，不能导出。"; exit 1; }
  done
  docker volume inspect "$volume" >/dev/null || { echo "缺少持久账本数据卷：$volume"; exit 1; }
  temp=$(mktemp -d)
  mkdir -p "$temp/secrets"
  cp -- .env.auto compose.generated.json "$temp/"
  cp -- secrets/newapi_admin_token secrets/newapi_database.json "$temp/secrets/"
  mapfile -t containers < <(docker ps -aq --filter label=com.docker.compose.project=newapi-compensation --filter label=com.docker.compose.service=compensation)
  for container in "${containers[@]}"; do
    [[ -n $container ]] || continue
    if [[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]]; then
      restart_containers+=("$container")
      docker stop --time 45 "$container" >/dev/null
    fi
  done
  writers=$(docker ps -q --filter "volume=$volume")
  [[ -z $writers ]] || { echo '账本卷仍被运行中的容器使用，已停止导出。'; exit 1; }
  run_helper -v "$volume:/data:ro" -v "$temp:/backup:rw" <<'NODE'
import { copyLedger } from '/app/src/deployment-recovery.mjs';
copyLedger('/data', '/backup/volume');
NODE
  archive_pending=$(mktemp "$(dirname -- "$archive")/.yunxiang-migration.XXXXXX")
  tar --create --gzip --file "$archive_pending" --directory "$temp" .
  chmod 600 "$archive_pending"
  # A hard link publishes the finished archive without overwriting an existing path.
  ln -- "$archive_pending" "$archive"
  rm -- "$archive_pending"
  archive_pending=''
  echo "迁移包已创建：$archive"
  exit 0
fi

[[ -f $archive && ! -L $archive ]] || { echo "迁移包不存在或是链接：$archive"; exit 1; }
for file in .env.auto compose.generated.json secrets/newapi_admin_token secrets/newapi_database.json; do
  [[ ! -e $file && ! -L $file ]] || { echo '目标目录已有云响部署状态，禁止覆盖。'; exit 1; }
done
[[ ! -L secrets ]] || { echo 'secrets 目录不能是符号链接。'; exit 1; }
containers=$(docker ps -aq --filter label=com.docker.compose.project=newapi-compensation)
[[ -z $containers ]] || { echo '目标服务器已有云响容器，禁止覆盖导入。'; exit 1; }
if docker volume inspect "$volume" >/dev/null 2>&1; then
  echo "目标服务器已有账本数据卷 $volume，禁止覆盖。"
  exit 1
fi
temp=$(mktemp -d)
tar --list --gzip --file "$archive" > "$temp/members"
if awk '/^\// || /(^|\/)\.\.(\/|$)/ || /\\/ {bad=1} END {exit !bad}' "$temp/members"; then
  echo '迁移包包含越界路径，已停止导入。'; exit 1
fi
tar --list --verbose --gzip --file "$archive" > "$temp/types"
if awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit !bad}' "$temp/types"; then
  echo '迁移包包含链接或特殊文件，已停止导入。'; exit 1
fi
mkdir "$temp/package"
tar --extract --gzip --file "$archive" --directory "$temp/package" --no-same-owner --no-same-permissions
run_helper -v "$temp/package:/restore:ro" <<'NODE'
import { validateMigration } from '/app/src/deployment-recovery.mjs';
validateMigration('/restore');
NODE
docker volume create "$volume" >/dev/null
created_volume=1
run_helper -v "$volume:/data:rw" -v "$temp/package:/restore:ro" <<'NODE'
import { copyLedger } from '/app/src/deployment-recovery.mjs';
copyLedger('/restore/volume', '/data', { restore: true });
NODE
mkdir -p secrets
cp -- "$temp/package/.env.auto" "$temp/package/compose.generated.json" .
cp -- "$temp/package/secrets/newapi_admin_token" "$temp/package/secrets/newapi_database.json" secrets/
chmod 600 .env.auto compose.generated.json
chmod 700 secrets
chmod 444 secrets/newapi_admin_token secrets/newapi_database.json
echo '迁移数据已导入并通过 SQLite 完整性检查。运行 bash install.sh 完成路径、网络适配和启动检查。'
