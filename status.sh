#!/usr/bin/env bash
set -uo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v docker >/dev/null || { echo '未安装 Docker。'; exit 1; }
failed=0
echo '=== Docker 引擎 ==='
docker context show || failed=1
docker info --format '名称：{{.Name}}；版本：{{.ServerVersion}}' || failed=1
echo '=== 云响本地镜像（新旧名称） ==='
docker image ls --filter reference='*compensation*' || failed=1
echo '=== 云响 Compose 容器 ==='
docker ps -a --filter label=com.docker.compose.project=newapi-compensation --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || failed=1
if [[ -s docker-compose.yml ]]; then
  args=(-p newapi-compensation -f docker-compose.yml)
elif [[ -s .env.auto && -s compose.generated.json ]]; then
  args=(--env-file .env.auto -f compose.generated.json)
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
