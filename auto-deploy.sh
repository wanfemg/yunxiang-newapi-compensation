#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
trap 'code=$?; printf "部署失败（退出码 %s，行 %s），未删除持久数据。运行 bash status.sh 查看诊断。\n" "$code" "$LINENO" >&2; exit "$code"' ERR
non_interactive=0
case ${1:-} in
  --non-interactive) non_interactive=1 ;;
  --help|-h) exec bash install.sh --help ;;
  '') ;;
  *) echo "未知参数：$1"; exit 1 ;;
esac
(( $# <= 1 )) || { echo '参数过多。'; exit 1; }
# Read prompts from the terminal so both process substitution and curl pipes work.
prompt(){
  local label=$1 default=$2 answer=''
  if [[ $non_interactive == 0 && -r /dev/tty && -w /dev/tty ]]; then
    printf '%s' "$label" > /dev/tty
    IFS= read -r answer < /dev/tty || { echo '交互输入已结束。'; exit 1; }
  fi
  REPLY=${answer:-$default}
}
[[ $(uname -s) == Linux ]] || { echo '自动部署用于 Linux 服务器。'; exit 1; }
command -v docker >/dev/null || { echo '需要 Docker Engine 与 Compose v2。'; exit 1; }
docker info >/dev/null
docker compose version >/dev/null
echo "Docker context：$(docker context show)"
echo '镜像与容器将创建在此 Docker 引擎；宝塔必须连接同一引擎。'
command -v flock >/dev/null || { echo '需要 util-linux 的 flock，防止并发部署。'; exit 1; }
exec 9>.yunxiang-deploy.lock
flock -n 9 || { echo '已有云响部署正在运行。'; exit 1; }
mkdir -p secrets
chmod 700 secrets
node_tool(){ docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges --mount "type=bind,src=$PWD/src,dst=/app/src,readonly" -w /app node:24-bookworm-slim node "$@"; }
json_get(){ node_tool --input-type=module -e 'import fs from "node:fs";let x=JSON.parse(fs.readFileSync(0,"utf8"));for(const k of process.argv[1].split("."))x=x?.[k];process.stdout.write(typeof x==="object"?JSON.stringify(x):String(x??""));' "$1"; }
valid_port(){ [[ $1 =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }
if [[ -s .env.auto && -s compose.generated.json && -s secrets/newapi_database.json ]]; then
  echo '复用已有接入配置与持久数据卷，更新云响，不修改 云中猫API小站。'
else
  [[ ! -e .env.auto && ! -e compose.generated.json ]] || { echo '部署配置不完整，保留现有文件；核对 .env.auto、compose.generated.json 和数据库识别文件后重试。'; exit 1; }
  container=${NEWAPI_CONTAINER:-}
  url=${NEWAPI_URL:-}
  if [[ -z $container && -z $url ]]; then
    ids=$(docker ps -q)
    choices='[]'
    if [[ -n $ids ]]; then choices=$(docker inspect $ids | node_tool src/deployment.mjs candidates); fi
    count=$(printf '%s' "$choices" | node_tool --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync(0,"utf8")).length)')
    if [[ $count == 1 ]]; then container=$(printf '%s' "$choices" | json_get 0.name);
    elif [[ $count != 0 ]]; then
      printf '检测到多个 云中猫API小站 候选：\n%s\n' "$choices"
      prompt '选择 云中猫API小站 容器名称: ' ''; container=$REPLY
      [[ -n $container ]] || { echo '未选择容器。'; exit 1; }
    else
      echo '未发现 云中猫API小站 容器，使用主机服务或远程 API 接入。'
      prompt '云中猫API小站 地址 [http://127.0.0.1:3000]: ' 'http://127.0.0.1:3000'; url=$REPLY
    fi
  fi
  if [[ -n $container ]]; then
    [[ $container =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { echo '容器名无效。'; exit 1; }
    plan=$(docker inspect --type container --format '{{json .}}' "$container" | node_tool src/deployment.mjs container "${NEWAPI_NETWORK:-}" "${NEWAPI_PORT:-}")
  else
    # Pass addresses as arguments, never evaluate shell text from configuration.
    plan=$(node_tool --input-type=module -e 'import {deploymentPlan} from "./src/deployment.mjs";console.log(JSON.stringify(deploymentPlan(null,{url:process.argv[1]})))' "$url")
  fi
  url=$(printf '%s' "$plan" | json_get url)
  network=$(printf '%s' "$plan" | json_get network)
  if [[ $network != host ]]; then
    [[ $(docker network inspect --format '{{.Driver}}' "$network") == bridge ]] || { echo '自动接入仅支持 bridge 或 host 网络；其他模式使用 NEWAPI_URL 指定已发布的接口。'; exit 1; }
  fi
  mode=$(printf '%s' "$plan" | json_get mode)
  node_tool --input-type=module -e 'const u=new URL(process.argv[1]);if(u.username||u.password||u.search||u.hash||u.pathname!=="/"||!["https:","http:"].includes(u.protocol))process.exit(1);' "$url" || { echo '原站地址必须是不带凭据的根地址。'; exit 1; }
  echo "检测部署模式：$mode；接入：$url；云响网络：$network"
  app_port=${COMPENSATION_PORT:-3210}
  prompt "云响本地端口 [$app_port]: " "$app_port"; app_port=$REPLY
  valid_port "$app_port" || { echo '端口无效。'; exit 1; }
  app_port=$((10#$app_port))
  if command -v ss >/dev/null && ss -H -ltn | awk '{print $4}' | grep -Eq ":$app_port$"; then echo '端口已被使用，重新运行并选择空闲端口。'; exit 1; fi
  prompt "云响 HTTPS 域名 [http://127.0.0.1:$app_port]: " "${PUBLIC_ORIGIN:-http://127.0.0.1:$app_port}"; origin=${REPLY%/}
  [[ $origin =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ || $origin == "http://127.0.0.1:$app_port" ]] || { echo '域名须为不带路径的 HTTPS 地址。'; exit 1; }
  admin_id=${NEWAPI_ADMIN_USER_ID:-}
  if [[ -z $admin_id ]]; then prompt '云中猫API小站 站长用户 ID: ' ''; admin_id=$REPLY; fi
  [[ $admin_id =~ ^[1-9][0-9]*$ ]] || { echo '站长 ID 无效。'; exit 1; }
  # Compose interprets dollar signs: reject config interpolation in URLs.
  [[ $url != *'$'* && $url != *$'\n'* ]] || { echo '原站地址格式无效。'; exit 1; }
  printf 'PUBLIC_ORIGIN=%s\nNEWAPI_URL=%s\nNEWAPI_ADMIN_USER_ID=%s\nALLOW_HTTP_UPSTREAM=%s\n' "$origin" "$url" "$admin_id" "$([[ $url == http:* ]] && echo 1 || echo 0)" > .env.auto.pending
  printf '%s' "$plan" | json_get database > secrets/newapi_database.json
  node_tool --input-type=module -e 'import {composePlan} from "./src/deployment.mjs";console.log(JSON.stringify(composePlan({network:process.argv[1],port:Number(process.argv[2])}),null,2))' "$network" "$app_port" > compose.generated.json
  mv -- .env.auto.pending .env.auto
fi
if [[ -s .env.auto && -s compose.generated.json && -s secrets/newapi_database.json ]]; then
  echo '检查迁移部署状态：安装路径、外部网络与持久账本。'
  volume=newapi-compensation_compensation_data
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    recovery_source=''
    if [[ -s data/compensation.sqlite ]]; then
      recovery_source=$PWD/data
      echo '发现本地导入的账本备份，准备恢复到持久数据卷。'
    else
      recovery_temp=$(mktemp -d)
      if docker ps -a --format '{{.Names}}' | grep -qx yunxiang-compensation; then
        if docker cp yunxiang-compensation:/app/data "$recovery_temp/data" >/dev/null 2>&1 && [[ -s $recovery_temp/data/compensation.sqlite ]]; then
          recovery_source=$recovery_temp/data
          echo '发现现存容器内导入的账本备份，准备恢复到持久数据卷。'
        fi
      fi
    fi
    if [[ -z $recovery_source || ! -s $recovery_source/compensation.sqlite ]]; then
      echo '新服务器缺少持久账本数据卷 newapi-compensation_compensation_data，且未找到可恢复的账本备份。'
      echo '云响不会新建空账本冒充迁移成功。请保留以下任一来源后重试：'
      echo '  1. 当前目录 data/compensation.sqlite（含同目录 WAL/SHM 文件）'
      echo '  2. 现存 yunxiang-compensation 容器内的 /app/data'
      echo '  3. 旧服务器 bash migrate.sh export yunxiang-migration.tar.gz，本机 bash migrate.sh import yunxiang-migration.tar.gz'
      [[ -n ${recovery_temp:-} ]] && rm -rf -- "$recovery_temp"
      exit 1
    fi
    if ! node_tool --input-type=module -e 'import fs from "node:fs";const b=fs.readFileSync(process.argv[1]);process.exit(b.subarray(0,15).toString("latin1")==="SQLite format 3"?0:1)' "$recovery_source/compensation.sqlite"; then
      echo '账本备份不是有效 SQLite 文件，已停止启动。'
      [[ -n ${recovery_temp:-} ]] && rm -rf -- "$recovery_temp"
      exit 1
    fi
    docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
      -v "$recovery_source:/restore:ro" -v "$volume:/data:rw" -w /data \
      node:24-bookworm-slim node -e 'const fs=require("fs");const source=process.env.RECOVERY_SOURCE||"/restore";fs.copyFileSync(source+"/compensation.sqlite","/data/compensation.sqlite");for(const name of ["compensation.sqlite-wal","compensation.sqlite-shm","secrets.key","dingtalk.enc"]){try{fs.copyFileSync(source+"/"+name,"/data/"+name)}catch{}}fs.chmodSync("/data",0o700)'
    if [[ -f $recovery_source/compensation.sqlite ]]; then :; else
      echo '账本恢复失败：未找到 SQLite 主文件。'
      [[ -n ${recovery_temp:-} ]] && rm -rf -- "$recovery_temp"
      exit 1
    fi
    docker volume inspect "$volume" >/dev/null
    echo "已恢复持久账本数据卷：$volume"
    [[ -n ${recovery_temp:-} ]] && rm -rf -- "$recovery_temp"
    unset recovery_source recovery_temp
  fi
  recovery=$(node_tool src/deployment-recovery.mjs normalize "$PWD" < compose.generated.json)
  recovery_changes=$(printf '%s' "$recovery" | node_tool --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync(0,"utf8")).changes.join(","))')
  if [[ -n $recovery_changes ]]; then
    printf '%s' "$recovery" | node_tool --input-type=module -e 'import fs from "node:fs";process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0,"utf8")).compose,null,2)+"\n")' > compose.generated.json.pending
    mv -- compose.generated.json.pending compose.generated.json
    echo "已修复迁移带来的绝对路径：$recovery_changes"
  fi
  network=$(node_tool --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync(0,"utf8")).services.compensation.network_mode)' < compose.generated.json)
  if [[ $network != host ]]; then
    if ! docker network inspect "$network" >/dev/null 2>&1; then
      echo "外部网络 $network 不存在，正在按当前 云中猫API小站 容器重新识别。"
      db_container=''
      [[ -z $db_container ]] && db_container=$(printf '%s' "$(node_tool --input-type=module -e 'import fs from "node:fs";const m=JSON.parse(fs.readFileSync("secrets/newapi_database.json","utf8"));console.log(m.container||"")')" | tr -d '\r')
      inspected=''
      if [[ -z $db_container ]]; then
        ids=$(docker ps -q)
        if [[ -n $ids ]]; then
          choices=$(docker inspect $ids | node_tool src/deployment.mjs candidates)
          count=$(printf '%s' "$choices" | node_tool --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync(0,"utf8")).length)')
          if [[ $count == 1 ]]; then db_container=$(printf '%s' "$choices" | json_get 0.name); fi
        fi
      fi
      if [[ -n $db_container ]]; then inspected=$(docker inspect --type container --format '{{json .}}' "$db_container"); fi
      recovered=''
      if [[ -n $inspected ]]; then
        recovered=$(node_tool src/deployment-recovery.mjs network < compose.generated.json "$inspected" "${NEWAPI_NETWORK:-}" 2>/dev/null || true)
      elif [[ -n ${NEWAPI_NETWORK:-} ]]; then
        recovered=$(node_tool src/deployment-recovery.mjs set-network "${NEWAPI_NETWORK:-}" < compose.generated.json 2>/dev/null || true)
      fi
      if [[ -z $recovered ]]; then
        echo '无法唯一识别新服务器上的 云中猫API小站 网络。'
        [[ -n ${NEWAPI_NETWORK:-} ]] || echo '设置 NEWAPI_NETWORK=<网络名> 后重试；或使用 NEWAPI_URL 指定已发布的原站地址重新迁移。'
        exit 1
      fi
      network=$(printf '%s' "$recovered" | node_tool --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync(0,"utf8")).compose.services.compensation.network_mode)')
      printf '%s' "$recovered" | node_tool --input-type=module -e 'import fs from "node:fs";const x=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(JSON.stringify(x.compose,null,2)+"\n")' > compose.generated.json.pending
      mv -- compose.generated.json.pending compose.generated.json
      echo "已恢复云响网络：$network"
    fi
    [[ $(docker network inspect --format '{{.Driver}}' "$network") == bridge ]] || { echo '云响外部网络必须是 bridge 网络。'; exit 1; }
  fi
fi
if [[ ! -s secrets/newapi_admin_token ]]; then
  token=${NEWAPI_ADMIN_TOKEN:-}
  if [[ -n ${NEWAPI_ADMIN_TOKEN_FILE:-} ]]; then
    [[ -r $NEWAPI_ADMIN_TOKEN_FILE ]] || { echo '管理令牌文件不可读。'; exit 1; }
    token=$(< "$NEWAPI_ADMIN_TOKEN_FILE")
  elif [[ -z $token && $non_interactive == 0 && -r /dev/tty && -w /dev/tty ]]; then
    printf '云中猫API小站 管理令牌（隐藏输入）: ' > /dev/tty
    IFS= read -r -s token < /dev/tty; printf '\n' > /dev/tty
  fi
  [[ -n $token && ! $token =~ [[:space:]] ]] || { echo '令牌无效。'; exit 1; }
  printf '%s' "$token" > secrets/newapi_admin_token
  unset token
fi
unset NEWAPI_ADMIN_TOKEN
# Migrate names without changing the Compose project or persistent ledger volume.
node_tool --input-type=module -e 'import fs from "node:fs";const p=JSON.parse(fs.readFileSync(0,"utf8"));if(p.name!=="newapi-compensation"||!p.services?.compensation)throw Error("未知的编排配置，未迁移");p.services.compensation.image="yunxiang-newapi-compensation:local";p.services.compensation.container_name="yunxiang-compensation";p.volumes.compensation_data={...p.volumes.compensation_data,name:"newapi-compensation_compensation_data"};console.log(JSON.stringify(p,null,2));' < compose.generated.json > compose.generated.json.pending
mv -- compose.generated.json.pending compose.generated.json
chmod 600 .env.auto compose.generated.json
chmod 444 secrets/newapi_admin_token secrets/newapi_database.json
# Saved configuration wins on updates; never reconnect a ledger via shell env.
unset PUBLIC_ORIGIN NEWAPI_URL NEWAPI_ADMIN_USER_ID ALLOW_HTTP_UPSTREAM
# Export resolved paths/config so panel imports do not depend on .env.auto.
docker compose --env-file .env.auto -f compose.generated.json config > docker-compose.yml.pending
[[ -s docker-compose.yml.pending ]] || { echo '标准编排文件生成失败。'; exit 1; }
chmod 600 docker-compose.yml.pending
mv -- docker-compose.yml.pending docker-compose.yml
compose(){ docker compose -p newapi-compensation -f docker-compose.yml "$@"; }
compose config --quiet
compose up -d --build --wait --wait-timeout 180
compose exec -T compensation node src/preflight.mjs
docker image inspect yunxiang-newapi-compensation:local --format '镜像已创建：{{index .RepoTags 0}}（{{.Id}}）'
compose ps
compose exec -T compensation node --input-type=module -e 'console.log("访问地址："+process.env.PUBLIC_ORIGIN);console.log("本机入口：http://127.0.0.1:"+process.env.PORT);'
echo '云响已启动。反向代理指向所选本机端口，申请及发放默认关闭。'
echo '持久数据：newapi-compensation_compensation_data；更新不会删除数据库。'
echo "宝塔编排导入文件：$PWD/docker-compose.yml"
echo '宝塔 Docker → 编排：导入上方现有文件；不要另建副本、不要改项目名或数据卷。'
echo 'Docker Compose 项目名：newapi-compensation；容器名：yunxiang-compensation'
echo '宝塔镜像搜索：yunxiang-newapi-compensation（同时检查本地镜像，不是镜像仓库搜索）。'
echo '备份：docker compose -p newapi-compensation -f docker-compose.yml exec -T compensation node src/backup.mjs'
echo '迁移：旧服务器 bash migrate.sh export <包>；新服务器 bash migrate.sh import <包> 后运行本脚本。'
echo '诊断：bash status.sh；日志：docker compose -p newapi-compensation -f docker-compose.yml logs --tail 100 compensation'
echo '更新：在本目录运行 bash install.sh；下载式更新使用原一键命令。'
echo '登录：使用原 云中猫API小站 用户或站长账号；生产不会创建演示账号。'
