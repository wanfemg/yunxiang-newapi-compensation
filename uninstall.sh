#!/usr/bin/env bash
set -euo pipefail
umask 077

show_help() {
  printf '%s\n' \
    '云响彻底卸载：bash uninstall.sh [--yes|--non-interactive]' \
    '安装目录：YUNXIANG_INSTALL_DIR（默认 /opt/yunxiang）' \
    '删除对象：云响容器、Compose 项目、本地镜像、持久账本数据卷、secrets 与安装目录' \
    '保留对象：云中猫API小站 容器、网络、数据库、反向代理与 TLS 证书' \
    '交互模式需输入“彻底卸载”确认；--yes 或 --non-interactive 用于无人值守'
  exit 0
}

assumed_yes=0
for arg in "$@"; do
  case $arg in
    --help|-h)
      show_help "$arg"
      ;;
    --yes|--non-interactive)
      assumed_yes=1
      ;;
    *)
      echo "未知参数：$arg"
      exit 1
      ;;
  esac
done

[[ $(uname -s) == Linux ]] || { echo '卸载脚本用于 Linux 服务器。'; exit 1; }
command -v docker >/dev/null 2>&1 || { echo '未找到 docker 命令，先确认当前服务器和 Docker 引擎。'; exit 1; }

target=${YUNXIANG_INSTALL_DIR:-/opt/yunxiang}
case $target in
  /|/opt|/home|/root|/var|/usr|/etc)
    echo "拒绝删除高危路径：$target"
    exit 1
    ;;
esac

target=${target%/}
if [[ -d $target ]]; then
  target=$(cd -- "$target" && pwd -P)
fi

markers=0
for marker in install.sh auto-deploy.sh .env.auto compose.generated.json docker-compose.yml src/server.mjs; do
  [[ -e $target/$marker ]] && markers=1
done
if [[ -d $target && $markers -eq 0 ]]; then
  echo "目录不是云响安装目录，拒绝删除：$target"
  echo '确认路径后设置 YUNXIANG_INSTALL_DIR=<云响安装目录> 重新执行。'
  exit 1
fi

echo '将删除以下云响对象：'
echo '- 容器：yunxiang-compensation 与 Compose 项目 newapi-compensation 的容器'
echo '- 镜像：yunxiang-newapi-compensation:local'
echo '- 数据卷：newapi-compensation_compensation_data（包含云响账本与 secrets.key）'
echo "- 安装目录：$target"
echo '不会修改 云中猫API小站 容器、网络、数据库、反向代理或 TLS 证书。'

if (( assumed_yes == 0 )); then
  printf '%s' '输入“彻底卸载”确认删除：'
  IFS= read -r answer || true
  [[ ${answer:-} == 彻底卸载 ]] || { echo '未确认，已取消卸载。'; exit 1; }
fi

compose_files=()
[[ -f $target/compose.generated.json ]] && compose_files=(-f "$target/compose.generated.json")
if [[ -f $target/.env.auto ]]; then
  if ((${#compose_files[@]})); then
    compose_files=(--env-file "$target/.env.auto" "${compose_files[@]}")
  fi
fi

if ((${#compose_files[@]})); then
  if docker compose -p newapi-compensation "${compose_files[@]}" down --volumes --remove-orphans; then
    echo '已停止并删除 Compose 项目 newapi-compensation 的云响资源。'
  else
    echo '警告：Compose down 未完全成功，继续按精确名称清理云响对象。' >&2
  fi
fi

remove_named_containers() {
  local filter=$1 ids=()
  mapfile -t ids < <(docker ps -aq --filter "$filter" 2>/dev/null || true)
  ((${#ids[@]})) || return 0
  docker rm -f -- "${ids[@]}"
  echo "已删除云响容器：${ids[*]}"
}

remove_named_containers 'name=^/yunxiang-compensation$'
remove_named_containers 'label=com.docker.compose.project=newapi-compensation'

if docker volume inspect newapi-compensation_compensation_data >/dev/null 2>&1; then
  docker volume rm newapi-compensation_compensation_data
  echo '已删除云响账本数据卷：newapi-compensation_compensation_data。'
else
  echo '云响账本数据卷不存在，跳过。'
fi

if docker image inspect yunxiang-newapi-compensation:local >/dev/null 2>&1; then
  docker rmi yunxiang-newapi-compensation:local
  echo '已删除本地云响镜像：yunxiang-newapi-compensation:local。'
else
  echo '本地云响镜像不存在，跳过。'
fi

if [[ -d $target ]]; then
  if find "$target" -mindepth 1 -maxdepth 1 \
    ! -name '.' ! -name '..' ! -name 'docker.log' -exec rm -rf -- {} + 2>/dev/null; then
    echo "已清空云响安装目录：$target"
    rmdir -- "$target" 2>/dev/null || true
  else
    echo "已清理可删除内容，但目录被占用，请稍后手动删除：$target" >&2
  fi
else
  echo '云响安装目录不存在，跳过。'
fi

leftover_container=$(docker ps -aq --filter 'name=^/yunxiang-compensation$' --filter 'label=com.docker.compose.project=newapi-compensation' 2>/dev/null || true)
if [[ -n $leftover_container ]]; then
  echo '卸载后仍发现云响容器，请执行 bash status.sh 检查 Docker context。' >&2
  exit 1
fi
if docker volume inspect newapi-compensation_compensation_data >/dev/null 2>&1; then
  echo '卸载后仍发现云响数据卷，请检查 Docker context。' >&2
  exit 1
fi

echo '云响已彻底卸载。云中猫API小站 未被修改。'
