#!/usr/bin/env bash
# Sourced by auto-deploy.sh; shares terminal, helper and cleanup behavior.
link_temp=''
link_prepared=''
link_backup=.yunxiang-link.rollback

link_tool(){
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,src=$PWD/src,dst=/app/src,readonly" \
    --mount "type=bind,src=$PWD/public,dst=/app/public,readonly" \
    --mount "type=bind,src=$link_temp,dst=/link,readonly" -w /app \
    node:24-bookworm-slim node src/newapi-link.mjs context /link "$@"
}

link_probe(){
  local namespace=$1 operation=$2
  docker run --rm -i --network "$namespace" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,src=$PWD/src,dst=/app/src,readonly" \
    --mount "type=bind,src=$PWD/public,dst=/app/public,readonly" -w /app \
    node:24-bookworm-slim node src/upstream-check.mjs "$operation"
}

yx_discover_newapi(){
  local ids choices count index requested networks network_count requests path key copied_size engine_id
  [[ -n $link_temp ]] || link_temp=$(mktemp -d /tmp/yunxiang-link.XXXXXX)
  engine_id=$(docker info --format '{{.ID}}')
  [[ $engine_id =~ ^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$ ]] || yx_die 'Docker 引擎身份读取失败，未应用关联配置。'
  container=${NEWAPI_CONTAINER:-}
  url=${NEWAPI_URL:-}
  if [[ -z $url || -n $container ]]; then
    ids=$(docker ps -q)
    printf '[]\n' > "$link_temp/inspect.json"
    [[ -z $ids ]] || docker inspect $ids > "$link_temp/inspect.json"
    choices=$(link_tool list)
    count=$(printf '%s' "$choices" | json_get length)
    if [[ -z $container && $count == 1 ]]; then
      container=$(printf '%s' "$choices" | json_get 0.container)
    elif [[ -z $container && $count -gt 1 ]]; then
      echo "检测到多个 NewAPI 主体（项目和文件路径仅用于识别）：$choices"
      ((yx_non_interactive == 0)) || yx_die '检测到多个 NewAPI 项目；使用 NEWAPI_CONTAINER 指定，未盲选第一个。'
      prompt '选择 NewAPI 容器编号（从 1 开始）或完整名称: ' ''
      requested=$REPLY
      if [[ $requested =~ ^[1-9][0-9]{0,3}$ ]] && ((10#$requested <= count)); then
        index=$((10#$requested-1)); container=$(printf '%s' "$choices" | json_get "$index.container")
      else container=$requested; fi
    fi
    if [[ -n $container ]]; then
      link_tool selected "$container" > "$link_temp/selected.json"
      container=$(json_get container < "$link_temp/selected.json")
      requests=$(link_tool files "$container")
      count=$(printf '%s' "$requests" | json_get length)
      for ((index=0;index<count;index++)); do
        key=$(printf '%s' "$requests" | json_get "$index.key")
        path=$(printf '%s' "$requests" | json_get "$index.path")
        # Copy only the exact, explicitly configured secret file. Never copy a project tree or source DB.
        docker cp "$container:$path" "$link_temp/$key" >/dev/null 2>&1 || yx_die "无法读取所选 NewAPI 的数据库配置文件：$key"
        [[ -f $link_temp/$key && ! -L $link_temp/$key ]] || yx_die '数据库配置文件不是普通文件。'
        copied_size=$(wc -c < "$link_temp/$key")
        ((copied_size > 0 && copied_size <= 65536)) || yx_die '数据库配置文件为空或过大。'
        chmod 600 "$link_temp/$key"
      done
      selected_network=${NEWAPI_NETWORK:-}
      networks=$(link_tool networks "$container")
      network_count=$(printf '%s' "$networks" | json_get length)
      if [[ -z $selected_network && $network_count -gt 1 ]]; then
        echo "原站已连接网络：$networks"
        ((yx_non_interactive == 0)) || yx_die '原站有多个网络；设置 NEWAPI_NETWORK 选择原站已连接的网络。'
        prompt '选择供云响连接的原站网络名称: ' ''
        selected_network=$REPLY
        [[ -n $selected_network ]] || yx_die '未选择原站网络。'
      fi
      plan=$(link_tool plan "$container" "$selected_network" "${NEWAPI_PORT:-}")
    fi
  fi
  if [[ -z $container ]]; then
    if [[ -z $url ]]; then
      local default_url=http://127.0.0.1:3000
      [[ ! -s .env.auto ]] || default_url=$(node_tool src/deployment-config.mjs get NEWAPI_URL < .env.auto)
      prompt "未发现 NewAPI 容器，输入原站根地址 [$default_url]: " "$default_url"
      url=$REPLY
    fi
    plan=$(node_tool --input-type=module -e 'import {deploymentPlan} from "./src/deployment.mjs";console.log(JSON.stringify(deploymentPlan(null,{url:process.argv[1]})))' "$url")
  fi
  plan=$(printf '%s' "$plan" | node_tool --input-type=module -e 'import fs from "node:fs";const p=JSON.parse(fs.readFileSync(0,"utf8"));p.database.engineId=process.argv[1];console.log(JSON.stringify(p));' "$engine_id")
  url=$(printf '%s' "$plan" | json_get url)
  network=$(printf '%s' "$plan" | json_get network)
  node_tool --input-type=module -e 'const u=new URL(process.argv[1]);if(u.username||u.password||u.search||u.hash||u.pathname!=="/"||!["https:","http:"].includes(u.protocol))throw Error("原站地址必须是不带凭据的根地址");' "$url"
  if [[ $network != host ]]; then
    [[ $(docker network inspect --format '{{.Driver}}' "$network") == bridge ]] || yx_die '原站网络必须是 bridge 或 host。'
  fi
  printf '%s\n' "$plan" > "$link_temp/plan.json"
  echo 'NewAPI 项目、文件与数据库识别结果（不含账号密码）：'
  link_tool summary
}

yx_verify_newapi(){
  local config_dir=$1 report paths count index path db_status=0 namespace
  cp -- "$config_dir/.env.auto" "$link_temp/probe.env"
  cp -- "$config_dir/secrets/newapi_admin_token" "$link_temp/probe.token"
  echo '从云响目标网络检查 NewAPI 管理身份、日志、额度读取及规则关联接口。'
  if ! link_tool api-input | link_probe "$network" --upstream > "$link_temp/api-check.json"; then
    [[ ! -s $link_temp/api-check.json ]] || cat "$link_temp/api-check.json"
    yx_die 'NewAPI 关联功能检查未通过；未应用新的接入配置。'
  fi
  cat "$link_temp/api-check.json"
  if [[ -n $container ]]; then
    report=$(printf '%s' "$plan" | node_tool --input-type=module -e 'import fs from "node:fs";const d=JSON.parse(fs.readFileSync(0,"utf8")).database;console.log([d.main,d.logs].some(x=>x.type==="unknown"||["ambiguous","unresolved"].includes(x.location))?"unresolved":"identified")')
    [[ $report != unresolved ]] || yx_die '所选项目的主库或日志库未唯一解析，未宣称识别成功；检查数据库配置来源和同网络目标。'
    paths=$(printf '%s' "$plan" | json_get database | node_tool src/newapi-link.mjs sqlite-files)
    count=$(printf '%s' "$paths" | json_get length)
    for ((index=0;index<count;index++)); do
      path=$(printf '%s' "$paths" | json_get "$index")
      # Bounded read from the original container: no DB mount, checkpoint, chmod, SQL or file writes.
      if ! docker exec "$container" sh -ec 'test -f "$1" && test -r "$1" && head -c 100 -- "$1"' sh "$path" |
        node_tool src/newapi-link.mjs sqlite-header; then yx_die '原站 SQLite 文件只读检查失败，未应用关联配置。'; fi
    done
    namespace="container:$(json_get id < "$link_temp/selected.json")"
    [[ $namespace != container: ]] || namespace="container:$container"
    [[ $(printf '%s' "$plan" | json_get mode) != docker-host ]] || namespace=host
    printf '%s' "$plan" | json_get database | link_probe "$namespace" --database > "$link_temp/database-check.json" || db_status=$?
    if ((db_status)); then
      [[ -s $link_temp/database-check.json ]] || yx_die '数据库探测未完成，未应用新关联。'
      report=$(node_tool --input-type=module -e 'import fs from "node:fs";const r=JSON.parse(fs.readFileSync(0,"utf8"));console.log(r.checks.some(c=>c.status==="failed")?"failed":"partial")' < "$link_temp/database-check.json")
      [[ $report != failed ]] || { cat "$link_temp/database-check.json"; yx_die '原站网络内的数据库端点不可达；已保留旧配置。'; }
    fi
    cat "$link_temp/database-check.json"
    echo '数据库端口/文件检查与 API 读取检查已分别报告；未验证直接 SQL 认证，不通过数据库执行补款。'
  else
    echo '远程或主机 API 接入：未读取远端项目与数据库文件；关联接口已只读验证。'
  fi
}

yx_rollback_newapi(){
  [[ -d $link_backup ]] || return 0
  [[ ! -L $link_backup && -z $(find "$link_backup" -type l -print -quit) ]] || { echo '关联回滚目录含链接，已保留现场。' >&2; return 1; }
  [[ -f $link_backup/manifest ]] || { echo '关联回滚目录不完整，已保留现场。' >&2; return 1; }
  if [[ -f $link_backup/active ]]; then
    if [[ -f $link_backup/published ]]; then
      docker compose -p newapi-compensation -f docker-compose.yml stop compensation >/dev/null || return 1
    fi
    if [[ -f $link_backup/rebound ]]; then
      volume_tool --mount "type=volume,src=$volume,dst=/data" node src/newapi-link.mjs ledger /data \
        "$(< "$link_backup/next-origin")" "$(< "$link_backup/previous-origin")" apply || return 1
    fi
    local item
    for item in .env.auto compose.generated.json docker-compose.yml secrets/newapi_database.json; do
      [[ -f $link_backup/$item ]] || return 1
      cp -p -- "$link_backup/$item" "$item.pending" && mv -f -- "$item.pending" "$item" || return 1
    done
    if [[ -f $link_backup/deploy-state ]]; then cp -p -- "$link_backup/deploy-state" "$state_file" || return 1; fi
    if [[ -f $link_backup/running ]]; then
      docker compose -p newapi-compensation -f docker-compose.yml up -d --no-build --wait --wait-timeout 180 || return 1
    fi
    echo '已恢复重新获取前的接入配置、账本绑定和云响运行状态。'
  fi
  rm -rf -- "$link_backup"
}

yx_refresh_newapi(){
  local result item old_url rebind
  docker volume inspect "$volume" >/dev/null 2>&1 || yx_die '已有账本卷缺失；先使用迁移修复恢复账本，未创建空账本。'
  [[ -s docker-compose.yml ]] || yx_die '缺少原标准编排文件；先运行安装或更新恢复编排，再重新获取关联。'
  yx_discover_newapi
  cp -- .env.auto "$link_temp/previous.env"
  cp -- compose.generated.json "$link_temp/previous-compose.json"
  cp -- secrets/newapi_database.json "$link_temp/previous-database.json"
  result=$(link_tool refresh "$PWD")
  mkdir -p "$link_temp/staged/secrets"
  printf '%s' "$result" | json_get env > "$link_temp/staged/.env.auto"
  printf '%s' "$result" | json_get compose > "$link_temp/staged/compose.generated.json"
  printf '%s' "$result" | json_get database > "$link_temp/staged/secrets/newapi_database.json"
  cp -- secrets/newapi_admin_token "$link_temp/staged/secrets/newapi_admin_token"
  yx_verify_newapi "$link_temp/staged"
  old_origin=$(printf '%s' "$result" | json_get association.previousOrigin)
  next_origin=$(printf '%s' "$result" | json_get association.nextOrigin)
  rebind=$(printf '%s' "$result" | json_get association.rebind)
  volume_tool --mount "type=volume,src=$volume,dst=/data,readonly" node src/newapi-link.mjs ledger /data "$old_origin" "$next_origin"
  # Do not let the invoking shell override the staged configuration during Compose expansion.
  unset PUBLIC_ORIGIN NEWAPI_URL NEWAPI_ADMIN_USER_ID ALLOW_HTTP_UPSTREAM
  docker compose -p newapi-compensation --project-directory "$PWD" --env-file "$link_temp/staged/.env.auto" \
    -f "$link_temp/staged/compose.generated.json" config > "$link_temp/staged/docker-compose.yml"
  [[ -s $link_temp/staged/docker-compose.yml ]] || yx_die '新的标准编排生成失败。'
  docker compose -p newapi-compensation -f "$link_temp/staged/docker-compose.yml" config --quiet
  docker compose -p newapi-compensation -f "$link_temp/staged/docker-compose.yml" build
  link_prepared=$(mktemp -d "$PWD/.yunxiang-link.prepare.XXXXXX")
  mkdir -p "$link_prepared/secrets"
  for item in .env.auto compose.generated.json docker-compose.yml secrets/newapi_database.json; do cp -p -- "$item" "$link_prepared/$item"; done
  [[ ! -s $state_file ]] || cp -p -- "$state_file" "$link_prepared/deploy-state"
  printf '%s\n' "$old_origin" > "$link_prepared/previous-origin"
  printf '%s\n' "$next_origin" > "$link_prepared/next-origin"
  printf 'yunxiang-newapi-link-v1\n' > "$link_prepared/manifest"
  running_ids=$(docker ps -q --filter label=com.docker.compose.project=newapi-compensation --filter label=com.docker.compose.service=compensation)
  [[ -z $running_ids ]] || touch "$link_prepared/running"
  mv -- "$link_prepared" "$link_backup"
  link_prepared=''
  touch "$link_backup/active"
  [[ -z $running_ids ]] || docker compose -p newapi-compensation -f docker-compose.yml stop compensation
  if [[ $rebind == true ]]; then
    touch "$link_backup/rebound"
    volume_tool --mount "type=volume,src=$volume,dst=/data" node src/newapi-link.mjs ledger /data "$old_origin" "$next_origin" apply
  fi
  touch "$link_backup/published"
  for item in .env.auto compose.generated.json docker-compose.yml secrets/newapi_database.json; do
    cp -- "$link_temp/staged/$item" "$item.pending"
    chmod 600 "$item.pending"
    [[ $item != secrets/newapi_database.json ]] || chmod 444 "$item.pending"
    mv -f -- "$item.pending" "$item"
  done
  docker compose -p newapi-compensation -f docker-compose.yml up -d --wait --wait-timeout 180
  docker compose -p newapi-compensation -f docker-compose.yml exec -T compensation node src/preflight.mjs
  set_phase ready
  rm -- "$link_backup/active"
  rm -rf -- "$link_backup"
  echo 'NewAPI 项目、主库、日志库及网络已重新获取；关联接口复查通过，原账本和管理令牌已保留。'
}
