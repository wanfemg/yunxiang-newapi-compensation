#!/usr/bin/env bash
set -euo pipefail
umask 077

fail(){ printf '%s\n' "$*" >&2; exit 1; }
show_help(){
  printf '%s\n' \
    '云响彻底卸载：bash uninstall.sh [--yes] [--non-interactive]' \
    '安装目录：YUNXIANG_INSTALL_DIR（默认 /opt/yunxiang）' \
    '交互模式输入“彻底卸载”确认；无人值守必须显式传入 --yes' \
    '删除云响容器、本地镜像、账本数据卷、secrets 和安装目录；保留原站及其网络、数据库和证书。'
}
confirmed=0
non_interactive=0
for arg in "$@"; do
  case $arg in
    --help|-h) show_help; exit 0 ;;
    --yes) confirmed=1 ;;
    --non-interactive) non_interactive=1 ;;
    *) fail "未知参数：$arg" ;;
  esac
done
(( non_interactive == 0 || confirmed == 1 )) || fail '无人值守卸载必须显式传入 --yes。'
[[ $(uname -s) == Linux ]] || fail '卸载脚本用于 Linux 服务器。'
command -v realpath >/dev/null || fail '需要 coreutils 的 realpath。'

requested_target=${YUNXIANG_INSTALL_DIR:-/opt/yunxiang}
[[ $requested_target == /* && $requested_target != *$'\n'* && $requested_target != *$'\r'* ]] || fail '使用专属安装目录的绝对路径。'
target=$(realpath -m -- "$requested_target")
lexical_target=$(realpath -ms -- "$requested_target")
[[ $target == "$lexical_target" ]] || fail '安装目录包含符号链接，未执行卸载。'
case $target in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib32|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/local|/var|/var/lib|/var/lib/docker|/www|/www/server|/www/wwwroot)
    fail "拒绝删除高危路径：$target" ;;
esac
[[ $target != "${HOME:-/root}" ]] || fail "拒绝删除高危路径：$target"
if [[ -e $target ]]; then
  [[ -d $target ]] || fail "安装路径不是目录：$target"
  recognized=0
  if [[ -f $target/package.json && -f $target/src/server.mjs ]] &&
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"newapi-empty-compensation"' "$target/package.json"; then
    recognized=1
  elif [[ -s $target/.env.auto && -s $target/compose.generated.json ]] &&
    grep -q '"newapi-compensation"' "$target/compose.generated.json" &&
    grep -q '"compensation"' "$target/compose.generated.json"; then
    recognized=1
  fi
  (( recognized )) || fail "目录缺少云响部署标识，拒绝删除：$target"
fi

command -v docker >/dev/null || fail '未找到 Docker，未删除安装文件。'
docker info >/dev/null || fail 'Docker 引擎不可用，未删除安装文件。'
command -v flock >/dev/null || fail '需要 util-linux 的 flock。'
lock_key=$(printf '%s' "$target" | cksum)
lock_key=${lock_key%% *}
lock_path="/tmp/yunxiang-${UID}-${lock_key}.lock"
[[ ! -L $lock_path ]] || fail '部署锁路径是符号链接。'
exec 9>"$lock_path"
flock -n 9 || fail '已有云响部署或卸载正在运行。'

volume=newapi-compensation_compensation_data
image=yunxiang-newapi-compensation:local
legacy_image=newapi-compensation:local
container_ids=()
volume_exists=0
image_exists=0
legacy_image_exists=0
collect_resources(){
  local named_ids project_ids id identity container_name project service container_image names tag
  named_ids=$(docker ps -aq --filter 'name=^/yunxiang-compensation$') || fail '读取云响容器失败，未删除安装文件。'
  project_ids=$(docker ps -aq --filter 'label=com.docker.compose.project=newapi-compensation' --filter 'label=com.docker.compose.service=compensation') || fail '读取云响 Compose 容器失败，未删除安装文件。'
  container_ids=()
  while IFS= read -r id; do
    [[ -n $id ]] || continue
    [[ $id =~ ^[a-zA-Z0-9_.-]+$ ]] || fail 'Docker 返回了无效容器标识。'
    identity=$(docker inspect --type container --format '{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}' "$id") || fail '核对容器归属失败，未删除安装文件。'
    IFS='|' read -r container_name project service container_image <<< "$identity"
    if [[ $project == newapi-compensation && $service == compensation ]] ||
      [[ $container_name == /yunxiang-compensation && ( $container_image == yunxiang-newapi-compensation:local || $container_image == newapi-compensation:local ) ]]; then
      container_ids+=("$id")
    else
      fail "同名容器不属于云响，已停止卸载：$id"
    fi
  done < <(printf '%s\n%s\n' "$named_ids" "$project_ids" | sort -u)
  names=$(docker volume ls --format '{{.Name}}' --filter "name=^${volume}$") || fail '读取云响数据卷失败，未删除安装文件。'
  volume_exists=0
  while IFS= read -r id; do [[ $id != "$volume" ]] || volume_exists=1; done <<< "$names"
  names=$(docker image ls --format '{{.Repository}}:{{.Tag}}' --filter "reference=$image") || fail '读取云响镜像失败，未删除安装文件。'
  image_exists=0
  while IFS= read -r tag; do [[ $tag != "$image" ]] || image_exists=1; done <<< "$names"
  names=$(docker image ls --format '{{.Repository}}:{{.Tag}}' --filter "reference=$legacy_image") || fail '读取历史云响镜像失败，未删除安装文件。'
  legacy_image_exists=0
  while IFS= read -r tag; do [[ $tag != "$legacy_image" ]] || legacy_image_exists=1; done <<< "$names"
}
collect_resources
if (( legacy_image_exists )); then
  docker run --rm --network none --read-only --user 1000:1000 --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 64 --memory 128m --entrypoint node "$legacy_image" \
    --input-type=module -e 'import fs from "node:fs";const p=JSON.parse(fs.readFileSync("/app/package.json","utf8"));process.exit(p.name==="newapi-empty-compensation"?0:1);' ||
    fail '历史镜像 newapi-compensation:local 未通过云响归属核验，未删除资源和安装文件。'
fi
printf 'Docker context：%s\n' "$(docker context show)"
printf '%s\n' \
  '将删除云响专属容器、镜像和账本数据卷（包括账本备份及加密密钥）。' \
  "安装目录：$target（包括源码、secrets 和部署配置）" \
  '云中猫API小站、Docker 网络、原站数据库、反向代理及证书均保留。'
if (( confirmed == 0 )); then
  answer=''
  printf '%s' '输入“彻底卸载”确认删除：' >&2
  if [[ -n ${YUNXIANG_INPUT_FD:-} ]]; then
    [[ $YUNXIANG_INPUT_FD =~ ^[0-9]+$ ]] || fail '交互输入描述符无效。'
    IFS= read -r -u "$YUNXIANG_INPUT_FD" answer || true
  elif [[ -t 0 ]]; then
    IFS= read -r answer || true
  elif { exec 8<>/dev/tty; } 2>/dev/null; then
    IFS= read -r -u 8 answer || true
    exec 8>&-
  else
    fail '没有可用交互终端；无人值守卸载必须显式传入 --yes。'
  fi
  [[ $answer == 彻底卸载 ]] || fail '未确认，已取消卸载。'
fi

if ((${#container_ids[@]})); then
  docker rm -f -- "${container_ids[@]}" || fail '云响容器删除失败，安装目录已保留。'
  echo '已删除云响容器。'
fi
if (( volume_exists )); then
  docker volume rm "$volume" || fail '云响账本数据卷删除失败，安装目录已保留。'
  echo "已删除云响账本数据卷：$volume"
fi
if (( image_exists )); then
  docker image rm "$image" || fail '云响镜像删除失败，安装目录已保留。'
  echo "已删除云响镜像：$image"
fi
if (( legacy_image_exists )); then
  docker image rm "$legacy_image" || fail '历史云响镜像删除失败，安装目录已保留。'
  echo "已删除历史云响镜像：$legacy_image"
fi
collect_resources
(( ${#container_ids[@]} == 0 && volume_exists == 0 && image_exists == 0 && legacy_image_exists == 0 )) ||
  fail '云响容器、镜像或数据卷仍有残留，安装目录已保留，卸载未完成。'
if [[ -d $target ]]; then
  [[ $(realpath -m -- "$target") == "$target" && ! -L $target ]] || fail '安装路径已变化，未删除安装目录。'
  cd /
  rm -rf --one-file-system -- "$target" || fail "安装目录删除失败：$target"
  [[ ! -e $target ]] || fail "安装目录仍有残留：$target"
  echo "已删除云响安装目录：$target"
fi
echo '云响已彻底卸载。云中猫API小站 未被修改。'
