#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf '%s\n' '云响一键部署：bash install.sh [--non-interactive]' \
    '安装目录：YUNXIANG_INSTALL_DIR（默认 /opt/yunxiang）' \
    '源码仓库：YUNXIANG_REPO（默认 wanfemg/yunxiang-newapi-compensation）' \
    '分支或标签：YUNXIANG_REF（默认 main）' \
    '首次配置：NEWAPI_URL 或 NEWAPI_CONTAINER、NEWAPI_ADMIN_USER_ID、NEWAPI_ADMIN_TOKEN_FILE、PUBLIC_ORIGIN' \
    '可选配置：COMPENSATION_PORT、NEWAPI_PORT、NEWAPI_NETWORK'
  exit 0
fi
[[ $(uname -s) == Linux ]] || { echo '一键部署入口用于 Linux 服务器。'; exit 1; }
if [[ -n ${BASH_SOURCE[0]:-} && -f $(dirname -- "${BASH_SOURCE[0]}")/auto-deploy.sh ]]; then
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  exec bash auto-deploy.sh "$@"
fi
command -v curl >/dev/null && command -v tar >/dev/null || { echo '需要 curl 与 tar。'; exit 1; }
repo=${YUNXIANG_REPO:-wanfemg/yunxiang-newapi-compensation}
ref=${YUNXIANG_REF:-main}
[[ $repo =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ && $ref =~ ^[a-zA-Z0-9_.-]+$ ]] || { echo '仓库或版本格式无效。'; exit 1; }
target=${YUNXIANG_INSTALL_DIR:-/opt/yunxiang}
mkdir -p -- "$target"
target=$(cd -- "$target" && pwd -P)
[[ $target != / && $target != /opt && $target != /home ]] || { echo '使用专属安装目录。'; exit 1; }
stage=$(mktemp -d /tmp/yunxiang-install.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
echo "下载云响：$repo @ $ref"
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
for item in src public test Dockerfile .dockerignore .gitattributes package.json auto-deploy.sh install.sh status.sh README.md; do
  [[ -e $source_dir/$item ]] || { echo "发布包缺少 $item"; exit 1; }
done
for item in src public test Dockerfile .dockerignore .gitattributes package.json auto-deploy.sh install.sh status.sh README.md; do
  [[ ! -L $target/$item ]] || { echo "安装路径是符号链接：$item"; exit 1; }
done
for item in src public test Dockerfile .dockerignore .gitattributes package.json auto-deploy.sh install.sh status.sh README.md; do cp -R -- "$source_dir/$item" "$target/"; done
mkdir -p -- "$target/docs"
[[ ! -L $target/docs ]] || { echo '文档目录是符号链接。'; exit 1; }
[[ ! -f $source_dir/docs/one-click.md ]] || cp -- "$source_dir/docs/one-click.md" "$target/docs/one-click.md"
cd -- "$target"
echo "云响源码已安装：$target（数据卷、secrets 和部署配置均保留）"
bash auto-deploy.sh "$@"
