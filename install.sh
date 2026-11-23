#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf '%s\n' '云响一键部署：bash install.sh [--non-interactive|--update|--migrate|--reinstall]' \
    '安装目录：YUNXIANG_INSTALL_DIR（默认 /opt/yunxiang）' \
    '源码仓库：YUNXIANG_REPO（默认 wanfemg/yunxiang-newapi-compensation）' \
    '分支或标签：YUNXIANG_REF（默认 main）' \
    '首次配置：NEWAPI_URL 或 NEWAPI_CONTAINER、NEWAPI_ADMIN_USER_ID、NEWAPI_ADMIN_TOKEN_FILE、PUBLIC_ORIGIN' \
    '可选配置：COMPENSATION_PORT、NEWAPI_PORT、NEWAPI_NETWORK' \
    '部署模式：已有部署交互选择更新/迁移修复/重新安装；无人值守默认 update' \
    '环境变量：YUNXIANG_DEPLOY_MODE=update|migrate|reinstall' \
    '跨服务器迁移：旧服务器 bash migrate.sh export <包>；新服务器 bash migrate.sh import <包>'
  exit 0
fi
[[ $(uname -s) == Linux ]] || { echo '一键部署入口用于 Linux 服务器。'; exit 1; }
mode_args=()
explicit_mode=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --non-interactive|--update|--migrate|--reinstall) mode_args+=("$1"); explicit_mode=1; shift; continue ;;
    --mode)
      [[ -n ${2:-} ]] || { echo '--mode 需要参数：update、migrate 或 reinstall。'; exit 1; }
      mode_args+=(--mode "$2"); explicit_mode=1; shift 2; continue
      ;;
    *) break ;;
  esac
done
(( $# == 0 )) || { echo "未知参数：$*"; exit 1; }
target=${YUNXIANG_INSTALL_DIR:-/opt/yunxiang}
mkdir -p -- "$target"
target=$(cd -- "$target" && pwd -P)
selected_mode=${YUNXIANG_DEPLOY_MODE:-}
if [[ $selected_mode == update || $selected_mode == migrate || $selected_mode == reinstall ]]; then explicit_mode=1; fi
if (( explicit_mode == 0 )) && [[ -s $target/.env.auto && -s $target/compose.generated.json && -s $target/secrets/newapi_database.json ]]; then
  cat >&2 <<'EOF'
检测到已有云响部署。请选择操作：
1. 更新（默认）：下载最新源码并重建启动，保留数据卷、secrets 和接入配置
2. 迁移修复：检查迁移路径、外部网络和持久账本，适合新服务器启动异常
3. 重新安装：删除旧容器后重建，保留数据卷、secrets 和接入配置
EOF
  choice=1
  if [[ -r /dev/stdin && -w /dev/stdin ]]; then
    printf '%s' '选择操作 [1-3，默认 1]: '
    IFS= read -r choice || choice=1
  else
    echo '无法读取交互输入；使用 --update、--migrate、--reinstall 或设置 YUNXIANG_DEPLOY_MODE。'
    exit 1
  fi
  case ${choice:-1} in
    1) selected_mode=update ;;
    2) selected_mode=migrate ;;
    3) selected_mode=reinstall ;;
    *) echo '选项无效。'; exit 1 ;;
  esac
fi
if [[ $selected_mode == migrate ]]; then mode_args+=(--non-interactive); fi
if [[ -n $selected_mode && $selected_mode != update ]]; then mode_args+=(--mode "$selected_mode"); fi
if [[ -n ${BASH_SOURCE[0]:-} && -f $(dirname -- "${BASH_SOURCE[0]}")/auto-deploy.sh ]]; then
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  exec bash auto-deploy.sh "${mode_args[@]}"
fi
command -v curl >/dev/null && command -v tar >/dev/null || { echo '需要 curl 与 tar。'; exit 1; }
repo=${YUNXIANG_REPO:-wanfemg/yunxiang-newapi-compensation}
ref=${YUNXIANG_REF:-main}
[[ $repo =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ && $ref =~ ^[a-zA-Z0-9_.-]+$ ]] || { echo '仓库或版本格式无效。'; exit 1; }
[[ $target != / && $target != /opt && $target != /home ]] || { echo '使用专属安装目录。'; exit 1; }
stage=$(mktemp -d /tmp/yunxiang-install.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
echo "下载云响：$repo @ $ref（部署模式：${selected_mode:-update}）"
curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 300 "https://api.github.com/repos/$repo/tarball/$ref" -o "$stage/source.tar.gz"
if tar -tzf "$stage/source.tar.gz" | awk '/^\// || /(^|\/)\.\.(\/|$)/ {bad=1} END {exit !bad}'; then echo '压缩包路径不安全。'; exit 1; fi
tar -xzf "$stage/source.tar.gz" -C "$stage" --no-same-owner --no-same-permissions
[[ -z $(find "$stage" -type l -print -quit) ]] || { echo '发布包包含符号链接，未修改现有安装。'; exit 1; }
source_dir=$(find "$stage" -maxdepth 3 -type f -name auto-deploy.sh -print)
[[ -n $source_dir && $source_dir != *$'\n'* ]] || { echo '下载版本不包含唯一的云响部署入口，未修改现有安装。'; exit 1; }
source_dir=$(dirname -- "$source_dir")
# Normalize downloaded scripts too: archives from older releases may use CRLF.
while IFS= read -r -d '' script; do sed -i 's/\r$//' "$script"; done < <(find "$source_dir" -type f -name '*.sh' -print0)
sed -i 's/\r$//' "$source_dir/Dockerfile"
for item in src public test Dockerfile .dockerignore .gitattributes package.json package-lock.json auto-deploy.sh install.sh status.sh migrate.sh README.md; do
  [[ -e $source_dir/$item ]] || { echo "发布包缺少 $item"; exit 1; }
done
for item in src public test Dockerfile .dockerignore .gitattributes package.json package-lock.json auto-deploy.sh install.sh status.sh migrate.sh README.md; do
  [[ ! -L $target/$item ]] || { echo "安装路径是符号链接：$item"; exit 1; }
done
for item in src public test Dockerfile .dockerignore .gitattributes package.json package-lock.json auto-deploy.sh install.sh status.sh README.md; do cp -R -- "$source_dir/$item" "$target/"; done
mkdir -p -- "$target/docs"
[[ ! -L $target/docs ]] || { echo '文档目录是符号链接。'; exit 1; }
[[ ! -f $source_dir/docs/one-click.md ]] || cp -- "$source_dir/docs/one-click.md" "$target/docs/one-click.md"
cd -- "$target"
echo "云响源码已安装：$target（数据卷、secrets 和部署配置均保留）"
bash auto-deploy.sh "${mode_args[@]}"
