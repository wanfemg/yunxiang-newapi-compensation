# 同机 Docker 部署

适用于 Linux 服务器已用 Docker 部署 云中猫API小站，补空回单独使用 Compose。不启动第二套 云中猫API小站，不挂载原站数据库，不修改原站容器。

## 引导部署

把整个补空回项目目录上传服务器，在该目录运行以下命令（Docker Engine 与 Compose v2 已安装，命令使用的账号可访问 Docker）：

~~~bash
bash deploy.sh
~~~

脚本列出容器，输入现有 云中猫API小站 容器名后，自动识别主库与日志库配置；随后输入它已连接的自定义 bridge 网络、内部端口、网站 HTTPS Origin、原管理用户 ID 和管理令牌。令牌隐藏输入并存放于 secrets/newapi_admin_token，不写入镜像或 Compose 环境变量。日志检查仅只读，不验证增额权限，不执行返还。网络名称必须从实际列表选择，不能按示例猜测。

## 数据库配置自动识别

- 从选定容器的 SQL_DSN、LOG_SQL_DSN、SQLITE_PATH、工作目录及挂载信息识别主库/日志库；支持识别 MySQL、PostgreSQL、SQLite 和独立 ClickHouse 日志库。日志库未独立配置时标记共用主库。
- SQLite 记录容器路径和对应挂载路径；容器层文件、特殊 DSN 明确标记，不能误认为已挂载或可访问。不会复制正在运行的 SQLite 文件，也不挂载原站卷。
- 连接串可能含数据库密码：仅保存必要字段到 secrets/newapi_database.json，通过 Compose secret 挂载，不输出到终端、普通环境文件或镜像；原始 docker inspect 仅通过管道传输，不落盘。secrets 目录权限为 700，文件为 444 以兼容非 root 容器，宿主机其他用户仍不可穿过目录访问。Docker 管理者仍能读取，备份必须受限。不要开启 shell 调试跟踪或公开这些文件。
- **自动识别不等于数据库直连。当前应用仍通过 云中猫API小站 接口读取日志及返还额度；不执行 SQL，不验证数据库密码和网络连通，也不自动取得管理令牌。** 本次不修改原站源码、容器或数据库。
- 使用外部文件/启动器动态注入数据库配置的部署不能保证识别，需人工核对；不自动提取容器内 secret 文件。
- 已保存配置默认复用；数据库配置变化后运行 REFRESH_NEWAPI_DB=1 bash deploy.sh 重新识别。已有配置要求所选容器与 NEWAPI_URL 一致，预检也校验实例名称。此脚本生成的地址使用容器名，不支持随意改成别名后忽略校验。
- 识别过程临时运行隔离网络的 Node 24 容器，首次需拉取镜像；该容器不挂载 Docker socket，也不连接数据库。

已有 .env.docker 和令牌时再次执行会复用配置并重建更新，不覆盖数据。参数更改前手动编辑 .env.docker；令牌更新用安全编辑器编辑文件，然后执行 Compose 的 --force-recreate。切换 云中猫API小站 实例会被数据绑定拒绝。

首次构建会拉取 node:24-bookworm-slim，并在镜像构建阶段跑自动化测试。运行容器不包含测试夹具、预览账号、.env、宿主机数据、源码仓库或 node_modules。运行用户非 root，根文件系统只读，数据单独持久化。镜像标签跟随 Node 24 安全更新；需要可复现发布时在部署验证后记录镜像 ID / 固定 digest。

## 同机连接与访问

- NEWAPI_URL 使用容器名与内部监听端口。容器里的 127.0.0.1 是补空回自身，不是 云中猫API小站。
- 默认仅发布到服务器 127.0.0.1:3210，公网不能直接通过服务器 IP:3210 访问。
- ALLOW_HTTP_UPSTREAM=1 明确允许选中的同机 Docker 网络使用 HTTP；公网连接仍使用 HTTPS。
- 复用 云中猫API小站 现有网络会使应用接触该网络的其他服务，正式环境可为两者单独配置业务网络并在原站 Compose 中持久声明；不要仅临时 docker network connect 后认为重建仍有效。
- Docker / 1Panel / 宝塔等一键部署方式的容器及网络名不同，脚本以实际 docker inspect 输出为准。
- 原站若仅连接默认 bridge、host 或外部编排网络，脚本会停止而不擅改原站；需先确定合适的持久网络配置。

## HTTPS 反向代理

宿主机已有 Nginx/宝塔时，域名代理目标设置为 http://127.0.0.1:3210，并启用有效 HTTPS 证书。PUBLIC_ORIGIN 必须与浏览器入口精确一致（协议、域名、端口），否则写操作会被拒绝。保留请求 Origin 与 Cookie，不缓存 /api。域名根路径部署，不挂到 /compensation 子路径。

反向代理若本身运行在容器中，不能使用其 127.0.0.1:3210；需将代理与补空回接到同一自定义网络，通过 compensation:3210 访问。根据实际代理网络增加 Compose 网络声明，不直接放开公网端口。HTTPS、DNS及证书必须在实际服务器配置，脚本不猜测或覆盖现有站点。

没有域名时使用 SSH 本地端口转发预览：服务器端 PUBLIC_ORIGIN 保持 http://127.0.0.1:3210，本机执行 ssh -L 3210:127.0.0.1:3210 后跟实际 SSH 主机，浏览器访问本机回环地址。HTTPS 域名正式确定后修改 PUBLIC_ORIGIN 并重建容器。

## 检查与更新

~~~bash
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs --tail 100 compensation
docker compose --env-file .env.docker exec -T compensation node src/preflight.mjs
# 代码更新后（运行脚本会同样执行这些操作）
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 120
~~~

健康状态只表示应用 HTTP 可用，不表示上游权限/余额到账正常。preflight 验证管理身份及日志读取，成功不代表账号密码登录、MFA、增额、钉钉全部兼容。原站启用的权限和验证要求不会被跳过。

## 数据和备份

申请、SQLite/WAL、机器人加密配置、加密密钥均在 compensation_data 命名卷。保留整个卷，不单独复制在线 SQLite 主文件。更新镜像不删除卷。不要执行 docker compose down -v，也不要部署多个副本共享 SQLite。

一致性备份：暂停新申请与执行，等待执行结束，再用 docker compose --env-file .env.docker stop compensation 停止应用，然后备份完整命名卷以及 .env.docker、secrets/；完成后 docker compose --env-file .env.docker start compensation。备份只存放于受限目录。恢复到同一个 云中猫API小站 实例；恢复过旧快照可能漏记已发放返还，必须先核对原站流水并保持执行开关关闭。

服务器目前尚未提供，当前交付为部署文件与本地测试，不代表已经在真实服务器构建或上线。
