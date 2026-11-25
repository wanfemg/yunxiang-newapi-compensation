#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./deploy-runtime.sh
yx_parse_args "$@"
if [[ -z $yx_mode && $yx_non_interactive == 0 || $yx_mode == uninstall ]]; then
  exec bash install.sh "$@"
fi
yx_mode=${yx_mode:-update}
((yx_yes == 0)) || yx_die '--yes 只用于确认卸载。'
[[ $(uname -s) == Linux ]] || yx_die '自动部署用于 Linux 服务器。'
yx_validate_target "$PWD"
yx_acquire_lock "$REPLY"
command -v docker >/dev/null || yx_die '需要 Docker Engine 与 Compose v2。'
docker info >/dev/null
docker compose version >/dev/null
echo "Docker context：$(docker context show)"
echo '安装器与宝塔需要连接同一 Docker 引擎。'
recovery_temp=''
restart_on_error=()
restore_created=0
restore_committed=0
cleanup(){
  local code=$?
  if ((code != 0)) && declare -F yx_rollback_newapi >/dev/null && [[ -d ${link_backup:-.yunxiang-link.rollback} ]]; then
    if ! yx_rollback_newapi; then echo 'NewAPI 关联回滚未完成；回滚配置已保留在 .yunxiang-link.rollback，修复后重运行部署入口。' >&2; fi
  fi
  [[ -z ${link_temp:-} ]] || rm -rf -- "$link_temp"
  [[ -z ${link_prepared:-} ]] || rm -rf -- "$link_prepared"
  if ((code != 0 && restore_created && restore_committed == 0)); then
    local references
    if references=$(docker ps -aq --filter "volume=$volume") && [[ -z $references ]] &&
      docker volume rm "$volume" >/dev/null; then
      echo '已撤回本次未完成的恢复卷；源账本已保留，重新运行会重新复制。' >&2
    else
      restart_on_error=()
      echo '未完成的恢复卷仍被占用，已保留新卷及源账本并保持源容器停止；未宣称恢复成功。' >&2
    fi
  fi
  [[ -z $recovery_temp ]] || rm -rf -- "$recovery_temp"
  if ((code != 0)); then
    for container in "${restart_on_error[@]}"; do
      if ! docker start "$container" >/dev/null 2>&1; then
        echo "原容器未恢复运行：$container；账本已保留，运行 bash status.sh 查看状态。" >&2
      fi
    done
    printf '部署未完成（退出码 %s）；接入配置和持久账本已保留。运行 bash status.sh 查看诊断。\n' "$code" >&2
  fi
}
trap cleanup EXIT
volume=newapi-compensation_compensation_data
state_file=.yunxiang-deploy-state
pending_dir=.yunxiang-config.pending
for path in secrets "$state_file" "$state_file.pending" "$pending_dir" .yunxiang-link.rollback .env.auto .env.auto.pending compose.generated.json compose.generated.json.pending docker-compose.yml docker-compose.yml.pending; do
  [[ ! -L $path ]] || yx_die "部署路径不能是符号链接：$path"
done
mkdir -p secrets
[[ -z $(find secrets -type l -print -quit) ]] || yx_die 'secrets 目录包含符号链接。'
chmod 700 secrets
phase=''
if [[ -s $state_file ]]; then
  phase=$(< "$state_file")
  case $phase in pending|started|ready) ;; *) yx_die '安装状态文件无效，未改动账本。' ;; esac
fi
set_phase(){
  printf '%s\n' "$1" > "$state_file.pending"
  chmod 600 "$state_file.pending"
  mv -f -- "$state_file.pending" "$state_file"
  phase=$1
}
node_tool(){
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,src=$PWD/src,dst=/app/src,readonly" -w /app \
    node:24-bookworm-slim node "$@"
}
volume_tool(){
  local options=()
  while [[ ${1:-} == --mount ]]; do options+=(--mount "$2"); shift 2; done
  docker run --rm --network none --read-only --tmpfs /tmp --user 0:0 \
    --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
    --mount "type=bind,src=$PWD/src,dst=/app/src,readonly" "${options[@]}" \
    -w /app node:24-bookworm-slim "$@"
}
json_get(){
  node_tool --input-type=module -e 'import fs from "node:fs";let x=JSON.parse(fs.readFileSync(0,"utf8"));for(const k of process.argv[1].split("."))x=x?.[k];process.stdout.write(typeof x==="object"?JSON.stringify(x):String(x??""));' "$1"
}
prompt(){
  if ((yx_non_interactive)); then REPLY=$2; else yx_read "$1" "$2" "${3:-0}"; fi
}
valid_port(){ [[ $1 =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }
source ./newapi-link.sh
if [[ -d $link_backup ]]; then
  echo '检测到未完成的 NewAPI 重新关联，先恢复上次稳定配置。'
  yx_rollback_newapi || yx_die '未能恢复上次关联，已保留回滚文件。'
  [[ ! -s $state_file ]] || phase=$(< "$state_file")
fi
commit_config(){
  local item
  for item in .env.auto compose.generated.json secrets/newapi_database.json secrets/newapi_admin_token; do
    [[ -s $pending_dir/$item ]] || return 1
  done
  for item in .env.auto compose.generated.json secrets/newapi_database.json secrets/newapi_admin_token; do
    [[ ! -L $item && ! -L $item.pending ]] || yx_die '配置路径包含符号链接。'
    cp -- "$pending_dir/$item" "$item.pending" || return 1
    chmod 600 "$item.pending" || return 1
    mv -f -- "$item.pending" "$item" || return 1
  done
  rm -rf -- "$pending_dir"
}
if [[ $phase == pending && -d $pending_dir ]]; then
  [[ -z $(find "$pending_dir" -type l -print -quit) ]] || yx_die '待完成配置包含符号链接。'
  if commit_config; then echo '已恢复上次中断的首次配置。'; fi
fi
saved_config=0
if [[ -s .env.auto && -s compose.generated.json && -s secrets/newapi_database.json ]]; then saved_config=1; fi
[[ $yx_mode != refresh || $saved_config == 1 ]] || yx_die '重新获取需要已有完整云响接入配置；首次部署选择 1. 安装。'
if ((saved_config == 0)); then
  [[ $yx_mode != migrate && $yx_mode != reinstall ]] || yx_die '未发现完整接入配置；首次安装选择 1. 安装，已有部署先导入迁移包。'
  [[ ! -e .env.auto && ! -e compose.generated.json ]] || yx_die '接入配置不完整，已保留现有文件；未创建空账本。'
  set_phase pending
  yx_discover_newapi
  app_port=${COMPENSATION_PORT:-3210}
  while :; do
    prompt "云响本地端口 [$app_port]: " "$app_port"
    if valid_port "$REPLY"; then app_port=$((10#$REPLY)); break; fi
    echo '端口须为 1 到 65535 的整数。' >&2
    ((yx_non_interactive == 0)) || exit 1
  done
  if command -v ss >/dev/null && ss -H -ltn | awk '{print $4}' | grep -Eq ":$app_port$"; then
    yx_die '本地端口已占用；重新选择 COMPENSATION_PORT。'
  fi
  origin_default=${PUBLIC_ORIGIN:-http://127.0.0.1:$app_port}
  while :; do
    prompt "云响域名（支持直接输入 yx.example.com） [$origin_default]: " "$origin_default"
    if origin=$(node_tool src/deployment-config.mjs origin "$REPLY" "$app_port"); then break; fi
    ((yx_non_interactive == 0)) || exit 1
  done
  admin_id=${NEWAPI_ADMIN_USER_ID:-}
  while [[ ! $admin_id =~ ^[1-9][0-9]*$ ]]; do
    prompt '云中猫API小站 站长用户 ID: ' ''
    admin_id=$REPLY
    [[ $admin_id =~ ^[1-9][0-9]*$ ]] && break
    echo '站长 ID 须为正整数。' >&2
    ((yx_non_interactive == 0)) || exit 1
  done
  token=${NEWAPI_ADMIN_TOKEN:-}
  if [[ -n ${NEWAPI_ADMIN_TOKEN_FILE:-} ]]; then
    [[ -r $NEWAPI_ADMIN_TOKEN_FILE ]] || yx_die '管理令牌文件不可读。'
    token=$(< "$NEWAPI_ADMIN_TOKEN_FILE")
  elif [[ -z $token && -s secrets/newapi_admin_token ]]; then
    token=$(< secrets/newapi_admin_token)
  elif [[ -z $token && $yx_non_interactive == 0 ]]; then
    yx_read '云中猫API小站 管理令牌（隐藏输入）: ' '' 1
    token=$REPLY
    unset REPLY
  fi
  [[ -n $token && ! $token =~ [[:space:]] ]] || yx_die '需要有效管理令牌；设置 NEWAPI_ADMIN_TOKEN_FILE。'
  mkdir -p "$pending_dir/secrets"
  printf 'PUBLIC_ORIGIN=%s\nNEWAPI_URL=%s\nNEWAPI_ADMIN_USER_ID=%s\nALLOW_HTTP_UPSTREAM=%s\n' \
    "$origin" "$url" "$admin_id" "$([[ $url == http:* ]] && echo 1 || echo 0)" > "$pending_dir/.env.auto"
  printf '%s' "$plan" | json_get database > "$pending_dir/secrets/newapi_database.json"
  node_tool --input-type=module -e 'import {composePlan} from "./src/deployment.mjs";console.log(JSON.stringify(composePlan({network:process.argv[1],port:Number(process.argv[2])}),null,2))' \
    "$network" "$app_port" > "$pending_dir/compose.generated.json"
  printf '%s' "$token" > "$pending_dir/secrets/newapi_admin_token"
  unset token NEWAPI_ADMIN_TOKEN
  node_tool src/deployment-config.mjs check < "$pending_dir/.env.auto" >/dev/null
  yx_verify_newapi "$pending_dir"
  commit_config
else
  echo "部署模式：$yx_mode；复用已有接入配置与持久账本。"
fi
node_tool src/deployment-config.mjs check < .env.auto >/dev/null
if [[ ! -s secrets/newapi_admin_token ]]; then
  token=${NEWAPI_ADMIN_TOKEN:-}
  if [[ -n ${NEWAPI_ADMIN_TOKEN_FILE:-} ]]; then
    [[ -r $NEWAPI_ADMIN_TOKEN_FILE ]] || yx_die '管理令牌文件不可读。'
    token=$(< "$NEWAPI_ADMIN_TOKEN_FILE")
  elif [[ -z $token && $yx_non_interactive == 0 ]]; then
    yx_read '云中猫API小站 管理令牌（隐藏输入）: ' '' 1
    token=$REPLY
    unset REPLY
  fi
  [[ -n $token && ! $token =~ [[:space:]] ]] || yx_die '已有接入配置缺少管理令牌；设置 NEWAPI_ADMIN_TOKEN_FILE 后重试。'
  printf '%s' "$token" > secrets/newapi_admin_token.pending
  chmod 600 secrets/newapi_admin_token.pending
  mv -f -- secrets/newapi_admin_token.pending secrets/newapi_admin_token
  unset token
fi
unset NEWAPI_ADMIN_TOKEN

if [[ $yx_mode == refresh ]]; then
  yx_refresh_newapi
  exit 0
fi
echo '检查部署状态：安装路径、原站网络和持久账本。'
fresh_volume=0
restore_volume=0
recovery_source=''
if ! docker volume inspect "$volume" >/dev/null 2>&1; then
  if [[ -s data/compensation.sqlite ]]; then
    recovery_source=$PWD/data
  else
    containers=$(docker ps -a --format '{{.Names}}')
    if grep -qx yunxiang-compensation <<< "$containers"; then
      recovery_temp=$(mktemp -d /tmp/yunxiang-recovery.XXXXXX)
      if [[ $(docker inspect --format '{{.State.Running}}' yunxiang-compensation) == true ]]; then
        restart_on_error+=(yunxiang-compensation)
        docker stop yunxiang-compensation >/dev/null
      fi
      if docker cp yunxiang-compensation:/app/data "$recovery_temp/data" &&
        [[ -s $recovery_temp/data/compensation.sqlite ]]; then recovery_source=$recovery_temp/data; fi
    fi
  fi
  if [[ -n $recovery_source ]]; then
    echo '已发现导入账本，验证并恢复到云响数据卷。'
    volume_tool --mount "type=bind,src=$recovery_source,dst=/restore,readonly" \
      node src/deployment-recovery.mjs check-volume /restore
    restore_volume=1
  elif [[ $phase == pending || $yx_mode == install && -z $phase ]]; then
    fresh_volume=1
    set_phase pending
    echo '首次安装：将在构建通过后创建新的持久账本数据卷。'
  elif [[ -z $phase && $yx_non_interactive == 0 && $yx_mode == update ]]; then
    echo '发现旧版接入配置，但没有数据卷、容器账本或备份。' >&2
    yx_read '确认为从未成功启动的新安装时，输入“全新安装”继续: ' ''
    [[ $REPLY == 全新安装 ]] || yx_die '未确认首次安装，已保留所有配置。'
    fresh_volume=1
    set_phase pending
  else
    yx_die '未找到已有持久账本；不会新建空账本冒充迁移成功。全新安装中断的旧版配置使用 --install 继续；已有账本请导入迁移包。'
  fi
fi
recovery=$(node_tool src/deployment-recovery.mjs normalize "$PWD" < compose.generated.json)
printf '%s' "$recovery" | json_get compose > compose.generated.json.pending
mv -f -- compose.generated.json.pending compose.generated.json
changes=$(printf '%s' "$recovery" | json_get changes)
[[ $changes == '[]' ]] || echo "已修复迁移带来的绝对路径：$changes"
network=$(node_tool --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync(0,"utf8")).services.compensation.network_mode)' < compose.generated.json)
if [[ $network != host ]]; then
  if ! docker network inspect "$network" >/dev/null 2>&1; then
    db_container=${NEWAPI_CONTAINER:-}
    [[ -n $db_container ]] || db_container=$(node_tool --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync(0,"utf8")).container||"")' < secrets/newapi_database.json)
    inspected=''
    if [[ -n $db_container ]]; then
      inspected=$(docker inspect --type container --format '{{json .}}' "$db_container" 2>/dev/null || true)
    fi
    if [[ -z $inspected ]]; then
      ids=$(docker ps -q)
      choices='[]'
      [[ -z $ids ]] || choices=$(docker inspect $ids | node_tool src/deployment.mjs candidates)
      if [[ $(printf '%s' "$choices" | json_get length) == 1 ]]; then
        db_container=$(printf '%s' "$choices" | json_get 0.name)
        inspected=$(docker inspect --type container --format '{{json .}}' "$db_container")
      fi
    fi
    if [[ -n $inspected ]]; then
      recovered=$(node_tool src/deployment-recovery.mjs network "$PWD" "$inspected" "${NEWAPI_NETWORK:-}" < compose.generated.json)
    elif [[ -n ${NEWAPI_NETWORK:-} ]]; then
      recovered=$(node_tool src/deployment-recovery.mjs set-network "$NEWAPI_NETWORK" < compose.generated.json)
    else
      yx_die '无法识别原站网络；设置 NEWAPI_CONTAINER 或 NEWAPI_NETWORK 后重试。'
    fi
    printf '%s' "$recovered" | json_get compose > compose.generated.json.pending
    mv -f -- compose.generated.json.pending compose.generated.json
    network=$(node_tool --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync(0,"utf8")).services.compensation.network_mode)' < compose.generated.json)
    echo "已恢复云响网络：$network"
  fi
  [[ $(docker network inspect --format '{{.Driver}}' "$network") == bridge ]] || yx_die '云响外部网络必须是 bridge 网络。'
fi
chmod 600 .env.auto compose.generated.json
chmod 444 secrets/newapi_admin_token secrets/newapi_database.json
# Saved configuration wins over the invoking shell; no shell evaluation of .env.
unset PUBLIC_ORIGIN NEWAPI_URL NEWAPI_ADMIN_USER_ID ALLOW_HTTP_UPSTREAM
docker compose -p newapi-compensation --env-file .env.auto -f compose.generated.json config > docker-compose.yml.pending
[[ -s docker-compose.yml.pending ]] || yx_die '标准编排生成失败。'
chmod 600 docker-compose.yml.pending
mv -f -- docker-compose.yml.pending docker-compose.yml
compose(){ docker compose -p newapi-compensation -f docker-compose.yml "$@"; }
compose config --quiet
if [[ $yx_mode == reinstall ]]; then compose build --no-cache; else compose build; fi
if ((restore_volume)); then
  docker volume create "$volume" >/dev/null
  restore_created=1
  volume_tool --mount "type=bind,src=$recovery_source,dst=/restore,readonly" \
    --mount "type=volume,src=$volume,dst=/data" node src/deployment-recovery.mjs restore-volume /restore /data
  restore_committed=1
  # After verification the restored volume becomes the only ledger allowed to receive writes.
  restart_on_error=()
  set_phase started
  echo "已恢复持久账本数据卷：$volume；旧写入源保持停止，后续重试使用此卷。"
fi
running_ids=$(docker ps -q --filter label=com.docker.compose.project=newapi-compensation --filter label=com.docker.compose.service=compensation)
if [[ -n $running_ids ]]; then
  for container in $running_ids; do restart_on_error+=("$container"); done
  compose stop compensation
fi
if ((fresh_volume)); then docker volume create "$volume" >/dev/null; fi
if [[ $phase != pending ]] || [[ $(volume_tool --mount "type=volume,src=$volume,dst=/data,readonly" \
  node --input-type=module -e 'import fs from "node:fs";console.log(fs.readdirSync("/data").length)') != 0 ]]; then
  volume_tool --mount "type=volume,src=$volume,dst=/data,readonly" node src/deployment-recovery.mjs check-volume /data
fi
volume_tool --mount "type=volume,src=$volume,dst=/data" sh -ec \
  'test -z "$(find /data -type l -print -quit)" && chown -R 1000:1000 /data && find /data -type d -exec chmod 700 {} + && find /data -type f -exec chmod 600 {} +'
docker run --rm --network none --read-only --user 1000:1000 --cap-drop ALL \
  --security-opt no-new-privileges --mount "type=volume,src=$volume,dst=/data" node:24-bookworm-slim \
  node --input-type=module -e 'import fs from "node:fs";const p="/data/.yunxiang-write-probe-"+process.pid;fs.writeFileSync(p,"ok",{flag:"wx",mode:0o600});fs.unlinkSync(p);'
up_args=(-d --wait --wait-timeout 180)
[[ $yx_mode != reinstall ]] || up_args+=(--force-recreate)
if compose up "${up_args[@]}"; then
  set_phase started
else
  up_error=$?
  if volume_tool --mount "type=volume,src=$volume,dst=/data,readonly" node --input-type=module \
    -e 'import fs from "node:fs";process.exit(fs.existsSync("/data/compensation.sqlite")?0:1)'; then
    set_phase started
  fi
  exit "$up_error"
fi
restart_on_error=()
compose exec -T compensation node src/preflight.mjs
set_phase ready
compose ps
compose exec -T compensation node --input-type=module -e 'console.log("访问地址："+process.env.PUBLIC_ORIGIN);console.log("本机入口：http://127.0.0.1:"+process.env.PORT);'
[[ $yx_mode != reinstall ]] || echo '已重建云响容器；账本、secrets 和接入配置均已保留。'
echo '云响已启动，健康检查与原站接入检查通过。'
echo "宝塔编排导入文件：$PWD/docker-compose.yml"
echo '账本：newapi-compensation_compensation_data；诊断：bash status.sh。'
