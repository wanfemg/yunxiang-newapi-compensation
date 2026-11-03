# 云响一键部署

## 下载式入口

源码发布到仓库 main 分支后，使用以下入口。此命令不会发布本地代码；未发布时远程地址不会包含本次改动。

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wanfemg/yunxiang-newapi-compensation/main/install.sh)
```

已有完整源码直接运行 `bash install.sh`。首次安装默认目录 `/opt/yunxiang`；修改路径使用 `YUNXIANG_INSTALL_DIR`，仓库与分支使用 `YUNXIANG_REPO`、`YUNXIANG_REF`。只支持 Linux + Docker Engine + Compose v2，不自动安装或修改 Docker、原站、反向代理或 TLS 证书。

首次运行会依次检测 Docker、Compose 与 NewAPI 容器，询问本机端口、访问域名、站长 ID 和管理令牌，再构建镜像、启动持久化服务并执行只读接入检查。成功后终端输出访问地址。管理令牌隐藏输入，不保存原站密码，不创建默认生产账号。Linux 需安装 `curl`、`tar`、`util-linux`（提供 `flock`）。

查看参数：`bash install.sh --help`。固定版本时将命令 URL 中的 `main` 与 `YUNXIANG_REF` 同时改成同一标签或提交号；不要只修改其中一个。

## 无人值守部署

先把 NewAPI 管理令牌保存到仅管理员可读的 `/root/newapi-admin-token`，再执行：

```bash
export NEWAPI_URL=https://newapi.example.com
export NEWAPI_ADMIN_USER_ID=1
export NEWAPI_ADMIN_TOKEN_FILE=/root/newapi-admin-token
export PUBLIC_ORIGIN=https://refund.example.com
export COMPENSATION_PORT=3210
bash <(curl -fsSL https://raw.githubusercontent.com/wanfemg/yunxiang-newapi-compensation/main/install.sh) --non-interactive
```

同机 Docker 自动适配使用 `NEWAPI_CONTAINER` 指定容器，不设置 `NEWAPI_URL`。多个网络使用 `NEWAPI_NETWORK`，非默认内部端口使用 `NEWAPI_PORT`。管理 ID、令牌缺失时安装报错退出，不生成猜测的凭据。更新使用已有配置，当前 shell 的原站地址、管理 ID 和域名不会覆盖已有账本的接入设置。

## 自动适配

- 从运行中容器名称、镜像、启动命令识别 NewAPI；多个候选必须选择，不盲选。
- Docker/Compose 自定义 bridge 网络：复用容器现有网络及内部 PORT，不挂载原站数据库。
- Docker host 网络：云响也使用 host 网络，原站连接宿主机回环地址。
- 未发现容器：输入主机服务或远程 NewAPI 根地址；云响以 host 网络容器运行。用 `NEWAPI_URL` 显式指定地址可跳过容器猜测；`NEWAPI_CONTAINER` 可指定容器。
- 只连接默认 bridge 的原站，自动读取发布到 `127.0.0.1` 或 `0.0.0.0` 的对应 TCP 端口，以 host 模式连接；未发布对应端口时要求使用 `NEWAPI_URL`，不会擅自修改原站网络。
- 首次输入云响端口、HTTPS Origin、站长 ID 和管理令牌。令牌隐藏输入，不能自动猜取。端口默认仅本机监听，域名仍需代理到本地端口。
- 数据库类型仅识别，识别文件不保存 DSN 密码。主机服务模式不声称识别了其数据库。日志与补款始终走 NewAPI API。

自动安装使用 `.env.auto`、`compose.generated.json`，不自动覆盖旧 `.env.docker` 配置。已有手动部署应先停止旧云响再切换入口并核对 NEWAPI_URL；命名卷同为 `newapi-compensation_compensation_data`，严禁双开或 `down -v`。远程接口 URL 不同也会触发账本实例绑定校验。

## 宝塔 Docker 面板

部署完成后对应对象：镜像 `yunxiang-newapi-compensation:local`、容器 `yunxiang-compensation`、Compose 项目 `newapi-compensation`。后者保留旧名称以复用已有服务和账本，数据卷明确固定为 `newapi-compensation_compensation_data`。

安装器在安装目录生成 `docker-compose.yml`，由 Docker Compose 导出标准 YAML，包含解析后的配置及绝对构建/secret 路径，不依赖宝塔额外读取 `.env.auto`。在宝塔 Docker 的编排管理中导入该现有文件，导入路径默认 `/opt/yunxiang/docker-compose.yml`。各宝塔版本的导入入口可能不同；面板未自动登记不代表 Docker 容器不存在。禁止手动写入宝塔内部数据库、复制到新的项目名重复运行，或更换数据卷造成去重账本丢失。配置文件虽然没有令牌正文，仍按 600 权限保管。

镜像列表查看本地镜像，不是在线仓库搜索。容器和镜像均看不到时，执行：

```bash
cd /opt/yunxiang
bash status.sh
```

诊断显示 Docker context、引擎名称、镜像、项目容器和健康接口，不显示管理令牌。安装器与宝塔需要连接同一 Docker 引擎。只有下载源码但构建或启动失败时，不会产生运行容器；保留终端报错再处理，不要删除持久卷。旧部署再次运行下载式一键命令，会自动迁移镜像/容器名称并导出标准编排，保留接入配置与数据卷。

## 持久化与备份

生产启动自动创建 `/app/data/compensation.sqlite`，WAL 模式。包含规则、原消费与申请快照、唯一请求索引、发放账本、查询缓存、审计事件及通知队列。不是 NewAPI 原数据库，也不是临时日志文件。设置页显示持久化状态；演示预览使用内存且明确标记。

```bash
cd /opt/yunxiang
docker compose --env-file .env.auto -f compose.generated.json exec -T compensation node src/backup.mjs
docker compose --env-file .env.auto -f compose.generated.json logs --tail 100 compensation
```

备份命令创建 SQLite 在线一致性快照，拒绝覆盖文件并执行 quick_check；快照位于持久卷 `/app/data/backups/`，仍需转存到独立受限存储，不是异地备份。另备份同卷 `secrets.key`、`dingtalk.enc` 以及宿主机 secrets、部署配置。禁止直接复制在线主文件而遗漏 WAL。恢复必须停止应用、对账、禁用执行后进行；旧快照可能缺少已发放记录。

## 更新

再次运行下载式入口下载源码并重建镜像，不删除数据卷，不覆盖 secrets 和既有部署配置。镜像构建会运行后端测试，上线后只读预检验证身份及日志读取，不发放额度。健康检查不代表真实补款与通知均已验证。

仅使用本地已下载的源码时，`bash install.sh` 会重新构建当前源码；需要获取仓库新版本时重新运行上方下载式命令。部署通过文件锁禁止并发操作。构建或接入检查失败会保留持久数据，终端不会输出部署成功。

Logo 从 NewAPI `/api/status` 的 `logo` 读取，站内路径由后端同源代理；外部 HTTPS Logo 由浏览器无 referrer 加载。缺失或加载失败保留默认云朵图标。
