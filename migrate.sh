#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

usage() {
  cat <<'EOF'
云响跨服务器迁移（旧服务器导出，新服务器导入）

旧服务器导出（不需要停止云响）：
  bash migrate.sh export /tmp/yunxiang-migration.tar.gz

新服务器导入（通常不需要；手动导入 data/compensation.sqlite 或容器内数据后直接运行 bash install.sh）：
  docker compose -p newapi-compensation -f docker-compose.yml down
  bash migrate.sh import /tmp/yunxiang-migration.tar.gz

导出内容：持久 SQLite 账本快照、宿主机 secrets、.env.auto、compose.generated.json。
不导出镜像和源码；新服务器先安装同版本源码，再执行导入，最后运行 bash install.sh。
EOF
}

[[ ${1:-} =~ ^(export|import)$ ]] || { usage; exit 1; }
[[ -n ${2:-} && $2 != */ ]] || { echo '迁移包路径无效。'; exit 1; }
action=$1 archive=$2
[[ $(uname -s) == Linux ]] || { echo '迁移工具用于 Linux 服务器。'; exit 1; }
command -v docker >/dev/null || { echo '需要 Docker Engine。'; exit 1; }
command -v tar >/dev/null || { echo '需要 tar。'; exit 1; }
volume=newapi-compensation_compensation_data

if [[ $action == export ]]; then
  [[ ! -e $archive ]] || { echo "目标文件已存在：$archive"; exit 1; }
  [[ -s .env.auto && -s compose.generated.json ]] || { echo '缺少部署配置，不能导出。'; exit 1; }
  for secret in newapi_admin_token newapi_database.json; do
    [[ -s secrets/$secret ]] || { echo "缺少 secrets/$secret，不能导出。"; exit 1; }
  done
  docker volume inspect "$volume" >/dev/null || { echo "缺少持久账本数据卷：$volume"; exit 1; }
  temp=$(mktemp -d)
  trap 'rm -rf -- "$temp"' EXIT
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
    -v "$volume:/data:ro" -v "$temp:/backup" -w /data alpine:3.20 \
    sh -c 'mkdir -p /backup/volume && cp -a /app/. /backup/volume/ 2>/dev/null || cp -a /data/. /backup/volume/'
  cp -- .env.auto compose.generated.json "$temp/"
  cp -- secrets/newapi_admin_token secrets/newapi_database.json "$temp/secrets.$$"
  mkdir -p "$temp/secrets"
  mv "$temp/secrets.$$"/* "$temp/secrets/"
  rmdir "$temp/secrets.$$"
  tar --create --gzip --file "$archive" --directory "$temp" .
  chmod 600 "$archive"
  echo "迁移包已创建：$archive"
  echo '新服务器安装源码后执行：bash migrate.sh import <迁移包>'
  exit 0
fi

[[ -f $archive ]] || { echo "迁移包不存在：$archive"; exit 1; }
[[ ! -e .env.auto && ! -e compose.generated.json && ! -e secrets/newapi_admin_token ]] || {
  echo '目标目录已有云响部署状态；导入前先备份并清空这些部署文件，不要覆盖账本。'
  exit 1
}
[[ -d secrets ]] || mkdir -p secrets
container=$(docker ps -aq --filter label=com.docker.compose.project=newapi-compensation)
if [[ -n $container ]]; then
  echo '检测到云响容器仍在运行或已存在；跨服务器导入前先执行：'
  echo 'docker compose -p newapi-compensation -f docker-compose.yml down'
  exit 1
fi
if docker volume inspect "$volume" >/dev/null 2>&1; then
  echo "目标 Docker 引擎已有数据卷：$volume"
  echo '禁止覆盖现有账本；如确认废弃它，先由管理员备份并删除后再导入。'
  exit 1
fi
temp=$(mktemp -d)
trap 'rm -rf -- "$temp"' EXIT
tar --extract --gzip --file "$archive" --directory "$temp"
[[ -s $temp/.env.auto && -s $temp/compose.generated.json && -s $temp/secrets/newapi_admin_token ]] || { echo '迁移包缺少部署配置或 secrets。'; exit 1; }
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  -v "$volume:/data:rw" -v "$temp:/restore:ro" -w /data alpine:3.20 \
  sh -c 'cp -a /restore/volume/. /data/'
cp -- "$temp/.env.auto" "$temp/compose.generated.json" .
cp -- "$temp/secrets/newapi_admin_token" "$temp/secrets/newapi_database.json" secrets/
chmod 600 .env.auto compose.generated.json
chmod 700 secrets
chmod 400 secrets/newapi_admin_token secrets/newapi_database.json
echo '迁移数据已导入。请执行 bash install.sh 完成路径、网络适配和启动检查。'
