#!/usr/bin/env bash
# Shared argument, terminal and locking behavior for deployment entrypoints.

yx_die(){ printf '%s\n' "$*" >&2; exit 1; }

yx_help(){
  printf '%s\n' \
    '云响一键部署：bash install.sh [--install|--update|--migrate|--reinstall|--uninstall|--refresh-newapi]' \
    '默认交互选择：安装/更新、迁移修复、重新安装（保留账本）、彻底卸载、重新获取 NewAPI。' \
    '--install / --fresh：明确继续首次安装，不删除任何已有数据。' \
    '--refresh-newapi / --rediscover / --reconnect：重新获取 NewAPI 项目、主库、日志库与网络并验证关联。' \
    '--mode install|update|migrate|reinstall|uninstall|refresh：与对应选项等效。' \
    '--non-interactive：不读取终端；卸载另须 --yes 才会删除数据。' \
    '--yes：确认卸载。--help：显示帮助。' \
    'YUNXIANG_INSTALL_DIR：安装目录（下载式默认 /opt/yunxiang，本地入口默认当前源码目录）。' \
    'YUNXIANG_REPO：wanfemg/yunxiang-newapi-compensation；YUNXIANG_REF：main。' \
    '首次配置：NEWAPI_URL 或 NEWAPI_CONTAINER、NEWAPI_ADMIN_USER_ID、NEWAPI_ADMIN_TOKEN_FILE、PUBLIC_ORIGIN。' \
    '公网域名可输入 yx.example.com，会自动补全 https://。'
}

yx_parse_args(){
  yx_mode=${YUNXIANG_DEPLOY_MODE:-}
  yx_non_interactive=0
  yx_yes=0
  local cli_mode='' candidate=''
  while (($#)); do
    case $1 in
      --install|--fresh) candidate=install ;;
      --update) candidate=update ;;
      --migrate) candidate=migrate ;;
      --reinstall) candidate=reinstall ;;
      --uninstall) candidate=uninstall ;;
      --refresh-newapi|--rediscover|--reconnect) candidate=refresh ;;
      --mode)
        (($# > 1)) || yx_die '--mode 缺少操作名称。'
        candidate=$2
        shift
        ;;
      --non-interactive) yx_non_interactive=1; shift; continue ;;
      --yes) yx_yes=1; shift; continue ;;
      --help|-h) yx_help; exit 0 ;;
      *) yx_die "未知参数：$1" ;;
    esac
    case $candidate in install|update|migrate|reinstall|uninstall|refresh) ;; *) yx_die "未知部署模式：$candidate" ;; esac
    [[ -z $cli_mode || $cli_mode == "$candidate" ]] || yx_die '一次只能指定一种部署操作。'
    cli_mode=$candidate
    shift
  done
  [[ -z $cli_mode ]] || yx_mode=$cli_mode
  case $yx_mode in ''|install|update|migrate|reinstall|uninstall|refresh) ;; *) yx_die "未知部署模式：$yx_mode" ;; esac
}

yx_read(){
  local label=$1 default=${2:-} secret=${3:-0} input_fd answer='' close_fd=0
  if [[ -n ${YUNXIANG_INPUT_FD:-} ]]; then
    [[ $YUNXIANG_INPUT_FD =~ ^[0-9]+$ ]] || yx_die '交互输入描述符无效。'
    input_fd=$YUNXIANG_INPUT_FD
  elif [[ -t 0 ]]; then
    input_fd=0
  else
    if ! { exec {input_fd}<>/dev/tty; } 2>/dev/null; then
      yx_die '未连接交互终端；使用 --non-interactive 并提供所需配置。'
    fi
    close_fd=1
  fi
  printf '%s' "$label" >&2
  if [[ $secret == 1 ]]; then
    IFS= read -r -s -u "$input_fd" answer || yx_die '交互输入已结束，未执行后续操作。'
    printf '\n' >&2
  else
    IFS= read -r -u "$input_fd" answer || yx_die '交互输入已结束，未执行后续操作。'
  fi
  REPLY=${answer:-$default}
  ((close_fd == 0)) || exec {input_fd}>&-
}

yx_select_mode(){
  [[ -z $yx_mode ]] || return 0
  if ((yx_non_interactive)); then yx_mode=update; return 0; fi
  cat >&2 <<'EOF'
云响一键部署。请选择操作：
1. 安装 / 更新（默认）：首次安装、继续未完成安装，或保留账本更新源码
2. 迁移修复：恢复导入账本，修复安装路径、数据权限和原站网络
3. 重新安装：重建云响容器与镜像，保留账本、secrets 和接入配置
4. 彻底卸载：删除云响容器、镜像、账本、secrets 和安装目录
5. 重新获取 NewAPI 项目与数据库：重新识别主体、配置文件、网络和主库/日志库，检查关联
0. 退出
EOF
  yx_read '选择操作 [0-5，默认 1]: ' 1
  case $REPLY in
    1) yx_mode=update ;;
    2) yx_mode=migrate ;;
    3) yx_mode=reinstall ;;
    4) yx_mode=uninstall ;;
    5) yx_mode=refresh ;;
    0) printf '%s\n' '已退出。'; exit 0 ;;
    *) yx_die '选项无效，未执行操作。' ;;
  esac
}

yx_validate_target(){
  local requested=$1 resolved lexical
  [[ -n $requested && $requested != *$'\n'* && $requested != *$'\r'* ]] || yx_die '安装目录无效。'
  [[ ! -L ${requested%/} ]] || yx_die '安装目录不能是符号链接。'
  resolved=$(realpath -m -- "$requested") || yx_die '无法解析安装目录。'
  lexical=$(realpath -ms -- "$requested") || yx_die '无法解析安装目录。'
  [[ $resolved == "$lexical" ]] || yx_die '安装路径包含符号链接。'
  case $resolved in
    /|/opt|/home|/root|/var|/var/lib|/var/lib/docker|/usr|/usr/local|/etc|/tmp|/srv|/www|/www/server|/www/wwwroot|/data|/bin|/sbin|/dev|/proc|/sys|/run|/mnt|/media)
      yx_die "拒绝操作高危路径：$resolved" ;;
  esac
  [[ $resolved != *$'\n'* ]] || yx_die '安装目录无效。'
  REPLY=$resolved
}

yx_acquire_lock(){
  local target=${1:?} key
  command -v flock >/dev/null || yx_die '需要 util-linux 的 flock，防止并发部署。'
  if [[ ${YUNXIANG_PARENT_LOCK_FD:-} =~ ^[0-9]+$ ]] &&
    { true <&"$YUNXIANG_PARENT_LOCK_FD"; } 2>/dev/null; then
    yx_lock_fd=$YUNXIANG_PARENT_LOCK_FD
    flock -n "$yx_lock_fd" || yx_die '已有云响部署或迁移操作正在执行。'
    return 0
  fi
  key=$(printf '%s' "$target" | cksum)
  key=${key%% *}
  local lock_path="/tmp/yunxiang-$(id -u)-$key.lock"
  [[ ! -L $lock_path ]] || yx_die '部署锁路径是符号链接。'
  exec {yx_lock_fd}>"$lock_path"
  flock -n "$yx_lock_fd" || yx_die '已有云响部署或迁移操作正在执行。'
}
