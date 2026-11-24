#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $(uname -s) == Linux ]] || { echo '一键部署入口用于 Linux 服务器。' >&2; exit 1; }

repo=${YUNXIANG_REPO:-wanfemg/yunxiang-newapi-compensation}
ref=${YUNXIANG_REF:-main}
[[ $repo =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ && $ref =~ ^[a-zA-Z0-9_.-]+$ ]] || {
  echo '仓库或版本格式无效。' >&2; exit 1;
}
script_dir=''
if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then
  script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
fi
stage=''
cleanup(){ [[ -z $stage ]] || rm -rf -- "$stage"; }
trap cleanup EXIT
download(){
  command -v curl >/dev/null || { echo '需要 curl。' >&2; exit 1; }
  curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 300 "$1" -o "$2"
}
local_source=''
if [[ -n $script_dir && -f $script_dir/auto-deploy.sh && -f $script_dir/deploy-runtime.sh ]]; then
  local_source=$script_dir
  source "$script_dir/deploy-runtime.sh"
else
  stage=$(mktemp -d /tmp/yunxiang-install.XXXXXX)
  download "https://raw.githubusercontent.com/$repo/$ref/deploy-runtime.sh" "$stage/deploy-runtime.sh"
  sed -i 's/\r$//' "$stage/deploy-runtime.sh"
  source "$stage/deploy-runtime.sh"
fi
yx_parse_args "$@"
yx_validate_target "${YUNXIANG_INSTALL_DIR:-${local_source:-/opt/yunxiang}}"
target=$REPLY
export YUNXIANG_INSTALL_DIR=$target
yx_select_mode

if [[ $yx_mode == uninstall ]]; then
  # Fetch only the uninstaller; never replace an installation before deleting it.
  uninstaller=${local_source:+$local_source/uninstall.sh}
  if [[ -z $uninstaller || ! -f $uninstaller ]]; then
    [[ -n $stage ]] || stage=$(mktemp -d /tmp/yunxiang-install.XXXXXX)
    uninstaller=$stage/uninstall.sh
    download "https://raw.githubusercontent.com/$repo/$ref/uninstall.sh" "$uninstaller"
    sed -i 's/\r$//' "$uninstaller"
  fi
  args=()
  ((yx_yes == 0)) || args+=(--yes)
  ((yx_non_interactive == 0)) || args+=(--non-interactive)
  cd /
  bash "$uninstaller" "${args[@]}"
  exit $?
fi
((yx_yes == 0)) || yx_die '--yes 只用于确认卸载；安装与更新不需要该选项。'

source_dir=$local_source
if [[ -z $source_dir ]]; then
  command -v tar >/dev/null || yx_die '需要 tar。'
  [[ -n $stage ]] || stage=$(mktemp -d /tmp/yunxiang-install.XXXXXX)
  echo "下载云响：$repo @ $ref（部署模式：$yx_mode）"
  download "https://api.github.com/repos/$repo/tarball/$ref" "$stage/source.tar.gz"
  tar -tzf "$stage/source.tar.gz" > "$stage/members"
  if awk '/^\// || /(^|\/)\.\.(\/|$)/ {bad=1} END {exit !bad}' "$stage/members"; then
    yx_die '压缩包路径不安全，未修改现有安装。'
  fi
  if tar -tvzf "$stage/source.tar.gz" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit !bad}'; then
    yx_die '发布包含链接或特殊文件，未修改现有安装。'
  fi
  mkdir "$stage/source"
  tar -xzf "$stage/source.tar.gz" -C "$stage/source" --no-same-owner --no-same-permissions
  source_dir=$(find "$stage/source" -mindepth 2 -maxdepth 2 -type f -name auto-deploy.sh -print)
  [[ -n $source_dir && $source_dir != *$'\n'* ]] || yx_die '发布包缺少唯一的云响部署入口。'
  source_dir=$(dirname -- "$source_dir")
  while IFS= read -r -d '' script; do sed -i 's/\r$//' "$script"; done < <(find "$source_dir" -type f -name '*.sh' -print0)
  sed -i 's/\r$//' "$source_dir/Dockerfile"
fi
for item in src public test Dockerfile .dockerignore .gitattributes package.json package-lock.json auto-deploy.sh deploy-runtime.sh install.sh status.sh migrate.sh uninstall.sh README.md; do
  [[ -e $source_dir/$item ]] || yx_die "发布包缺少 $item，未修改现有安装。"
done
yx_acquire_lock "$target"
mkdir -p -- "$target"
for item in src public test Dockerfile .dockerignore .gitattributes package.json package-lock.json auto-deploy.sh deploy-runtime.sh install.sh status.sh migrate.sh uninstall.sh README.md; do
  [[ ! -L $target/$item ]] || yx_die "安装路径是符号链接：$item"
  if [[ -d $target/$item && -n $(find "$target/$item" -type l -print -quit) ]]; then
    yx_die "安装目录含符号链接：$item"
  fi
done
if [[ $source_dir != "$target" ]]; then
  for item in src public test Dockerfile .dockerignore .gitattributes package.json package-lock.json auto-deploy.sh deploy-runtime.sh install.sh status.sh migrate.sh uninstall.sh README.md; do cp -R -- "$source_dir/$item" "$target/"; done
  [[ ! -L $target/docs ]] || yx_die '文档目录是符号链接。'
  mkdir -p -- "$target/docs"
  [[ ! -L $target/docs/one-click.md ]] || yx_die '部署说明是符号链接。'
  [[ ! -f $source_dir/docs/one-click.md ]] || cp -- "$source_dir/docs/one-click.md" "$target/docs/one-click.md"
fi
args=(--mode "$yx_mode")
((yx_non_interactive == 0)) || args+=(--non-interactive)
echo "云响源码已就绪：$target（保留账本、secrets 和接入配置）"
YUNXIANG_PARENT_LOCK_FD=$yx_lock_fd bash "$target/auto-deploy.sh" "${args[@]}"
