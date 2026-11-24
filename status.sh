#!/usr/bin/env bash
set -uo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v docker >/dev/null || { echo '未安装 Docker。'; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Docker 引擎不可用，无法判断部署状态；未改动配置和数据。'; exit 1; }
failed=0
echo '=== 云响安装状态 ==='
if [[ -s .yunxiang-deploy-state ]]; then
  phase=$(< .yunxiang-deploy-state)
  case $phase in
    pending) echo '首次配置或构建未完成：重新运行一键入口继续安装。' ;;
    started) echo '容器曾启动：账本必须保留；正在等待健康检查或原站接入检查通过。' ;;
    ready) echo '上一次部署已通过健康检查和原站接入检查。' ;;
    *) echo '安装状态文件无效。'; failed=1 ;;
  esac
else
  echo '旧版部署或尚未首次安装；安装器会核对持久账本后再执行操作。'
fi
echo '=== Docker 引擎 ==='
docker context show || failed=1
docker info --format '名称：{{.Name}}；版本：{{.ServerVersion}}' || failed=1
echo '=== 云响本地镜像（新旧名称） ==='
docker image ls --filter reference='*compensation*' || failed=1
echo '=== 云响 Compose 容器 ==='
docker ps -a --filter label=com.docker.compose.project=newapi-compensation --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || failed=1
echo '=== 持久账本数据卷 ==='
docker volume inspect newapi-compensation_compensation_data --format '名称：{{.Name}}；创建时间：{{.CreatedAt}}' || failed=1
if docker volume inspect newapi-compensation_compensation_data >/dev/null 2>&1; then
  echo '数据卷存在；缺失时不要重装成空账本，使用 migrate.sh 导入旧服务器备份。'
else
  echo '数据卷缺失：未完成的首次安装会继续；已有部署须恢复 data/compensation.sqlite、现存容器账本或迁移包。'
fi
if [[ -s docker-compose.yml ]]; then
  args=(-p newapi-compensation -f docker-compose.yml)
elif [[ -s .env.auto && -s compose.generated.json ]]; then
  args=(-p newapi-compensation --env-file .env.auto -f compose.generated.json)
else
  echo '部署配置缺失：安装可能只下载了源码，尚未构建启动。重新运行一键部署并保留错误输出。'
  exit 1
fi
docker compose "${args[@]}" ps -a || failed=1
echo '=== 本地健康检查（不访问余额接口） ==='
docker compose "${args[@]}" exec -T compensation node -e 'fetch("http://127.0.0.1:"+process.env.PORT+"/api/health").then(async r=>{if(!r.ok)throw Error("HTTP "+r.status);console.log(await r.text())}).catch(e=>{console.error(e.message);process.exitCode=1})' || failed=1
echo "标准编排文件：$PWD/docker-compose.yml"
echo '面板无记录但以上容器健康：在宝塔导入现有编排文件。镜像为空或容器缺失：查看一键部署错误；不要删除数据卷后重装。'
exit "$failed"
