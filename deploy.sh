#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v docker >/dev/null || { echo '先安装 Docker Engine 与 Compose 插件。'; exit 1; }
docker compose version >/dev/null
docker info >/dev/null
umask 077
mkdir -p secrets
chmod 700 secrets
if [[ ! -s secrets/newapi_database.json || "${REFRESH_NEWAPI_DB:-0}" == 1 ]]; then
  echo '自动识别数据库：只读取所选 NewAPI 容器的配置，不连接数据库、不修改原站。'
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
  read -r -p '用于识别数据库的 NewAPI 容器名称 [new-api]: ' db_container
  db_container=${db_container:-new-api}
  [[ "$db_container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { echo '容器名称格式不支持。'; exit 1; }
  if [[ -f .env.docker ]]; then
    configured_url=$(sed -n 's/^NEWAPI_URL=//p' .env.docker | tr -d '\r')
    configured_host=${configured_url#http://}
    configured_host=${configured_host%%:*}
    [[ "$configured_host" == "$db_container" ]] || { echo '所选容器与现有 NEWAPI_URL 不一致，拒绝覆盖数据库配置。'; exit 1; }
  fi
  db_temp=$(mktemp secrets/.newapi-database.XXXXXX)
  trap 'rm -f -- "$db_temp"' EXIT
  # Full inspect JSON exists only in the pipe; never print credentials or save it.
  if ! docker inspect --type container --format '{{json .}}' "$db_container" |
    docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
      --mount "type=bind,src=$(pwd)/src/db-discovery.mjs,dst=/discovery.mjs,readonly" \
      node:24-bookworm-slim node /discovery.mjs > "$db_temp"; then
    echo '数据库配置识别失败，未替换原配置。'; exit 1
  fi
  chmod 444 "$db_temp"
  mv -f -- "$db_temp" secrets/newapi_database.json
  trap - EXIT
  echo '数据库配置已识别并保存至受限 secret，密码不回显；尚未直连数据库。'
fi
if [[ ! -f .env.docker ]]; then
  echo '运行中的容器（只查看，不修改）：'
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
  container=${db_container:-}
  if [[ -z "$container" ]]; then
    read -r -p 'NewAPI 容器名称 [new-api]: ' container
    container=${container:-new-api}
  fi
  docker inspect --type container "$container" >/dev/null
  networks=$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container")
  printf 'NewAPI 已连接网络：\n%s\n' "$networks"
  read -r -p '选择一个上方的用户自定义 bridge 网络: ' network
  printf '%s\n' "$networks" | grep -Fx -- "$network" >/dev/null || { echo '网络不属于该容器。'; exit 1; }
  [[ "$network" != bridge && "$network" != host && "$network" != none ]] || { echo '需要用户自定义 bridge 网络。'; exit 1; }
  [[ $(docker network inspect --format '{{.Driver}}' "$network") == bridge ]] || { echo '本脚本支持同机 bridge 网络。'; exit 1; }
  read -r -p 'NewAPI 容器内部端口 [3000]: ' upstream_port
  upstream_port=${upstream_port:-3000}
  read -r -p '补空回宿主机回环端口 [3210]: ' app_port
  app_port=${app_port:-3210}
  for p in "$upstream_port" "$app_port"; do
    [[ "$p" =~ ^[0-9]{1,5}$ ]] && ((10#$p >= 1 && 10#$p <= 65535)) || { echo '端口必须在 1–65535。'; exit 1; }
  done
  read -r -p "网站 HTTPS 地址；本机预览回车使用 http://127.0.0.1:$app_port: " origin
  origin=${origin:-http://127.0.0.1:$app_port}
  origin=${origin%/}
  [[ "$origin" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ || "$origin" == "http://127.0.0.1:$app_port" ]] || { echo '填写完整 HTTPS Origin，不含路径。'; exit 1; }
  [[ "$container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && "$network" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { echo '容器或网络名称格式不支持。'; exit 1; }
  read -r -p '原站管理用户 ID: ' admin_id
  [[ "$admin_id" =~ ^[1-9][0-9]*$ ]] || { echo '用户 ID 必须为正整数。'; exit 1; }
  umask 077
  printf 'PUBLIC_ORIGIN=%s\nCOMPENSATION_PORT=%s\nNEWAPI_URL=http://%s:%s\nNEWAPI_NETWORK=%s\nNEWAPI_ADMIN_USER_ID=%s\nALLOW_HTTP_UPSTREAM=1\n' "$origin" "$app_port" "$container" "$upstream_port" "$network" "$admin_id" > .env.docker
fi
if [[ ! -s secrets/newapi_admin_token ]]; then
  mkdir -p secrets
  chmod 700 secrets
  read -r -s -p 'NewAPI 管理令牌（隐藏输入，非推理 sk- 密钥）: ' token
  printf '\n'
  [[ -n "$token" && ! "$token" =~ [[:space:]] ]] || { echo '令牌不能为空或包含空白。'; exit 1; }
  (umask 077; printf '%s' "$token" > secrets/newapi_admin_token)
  unset token
fi
# File-backed Compose secrets retain host modes; parent stays inaccessible to
# other host users, mounted file must be readable by the non-root container.
chmod 700 secrets
chmod 444 secrets/newapi_admin_token
chmod 600 .env.docker
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 120
docker compose --env-file .env.docker exec -T compensation node src/preflight.mjs
echo '容器与只读接入检查完成。外部访问仍需 HTTPS 反向代理；申请和执行默认关闭。'
echo '日志：docker compose --env-file .env.docker logs --tail 100 compensation'
