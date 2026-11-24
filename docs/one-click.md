# 云响一键部署

## 下载式入口

源码发布到仓库 main 分支后，使用以下入口。此命令不会发布本地代码；未发布时远程地址不会包含本次改动。

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wanfemg/yunxiang-newapi-compensation/main/install.sh)
```

已有完整源码直接运行 `bash install.sh`。首次安装默认目录 `/opt/yunxiang`；修改路径使用 `YUNXIANG_INSTALL_DIR`，仓库与分支使用 `YUNXIANG_REPO`、`YUNXIANG_REF`。只支持 Linux + Docker Engine + Compose v2，不自动安装或修改 Docker、原站、反向代理或 TLS 证书。

首次运行会依次检测 Docker、Compose 与 云中猫API小站 容器，询问本机端口、访问域名、站长 ID 和管理令牌，再构建镜像、启动持久化服务并执行只读接入检查。成功后终端输出访问地址。管理令牌隐藏输入，不保存原站密码，不创建默认生产账号。Linux 需安装 `curl`、`tar`、`util-linux`（提供 `flock`）。

查看参数：`bash install.sh --help`。固定版本时将命令 URL 中的 `main` 与 `YUNXIANG_REF` 同时改成同一标签或提交号。下载式入口先加载同版本的小型交互脚本，再显示操作菜单，选择后才下载完整源码：

1. 安装 / 更新：首次创建账本、继续未完成的首次安装，或保留账本更新。
2. 迁移修复：核对导入数据、安装路径、数据权限和原站网络。
3. 重新安装：先构建，再重建云响容器；保留账本、secrets 和接入配置。
4. 彻底卸载：输入确认文字后删除云响专属资源。
5. 重新获取 NewAPI 项目与数据库：重新识别当前原站、检查关联及连通性，通过后更新云响接入配置。
0. 退出：不执行部署或卸载。

端口和域名输入无效时，只重新询问当前字段。输入 `yx.yzmao.cn` 会保存为 `https://yx.yzmao.cn`；公网 HTTP、带路径或带凭据的地址会被拒绝。`--non-interactive` 关闭所有终端询问，必填配置缺失时明确报错；不会把管道中的脚本内容当作回答。命令行模式优先于 `YUNXIANG_DEPLOY_MODE`，冲突的命令行模式会报错。

## 首次安装失败后继续

`.yunxiang-deploy-state` 记录 `pending`（首次安装尚未创建账本）、`started`（账本已恢复、已写入或容器已启动）和 `ready`（健康及接入检查通过）。首次配置通过后即使构建失败，也保留配置和隐藏令牌；尚未写出数据库的启动失败也能重试。更新、迁移、重装不会删除旧账本来换成空账本。

旧版脚本可能只留下接入配置，没有安装状态、容器、数据卷和备份。交互入口会要求输入 `全新安装` 才允许继续初始化。确认为从未成功启动的安装时，也能明确指定：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wanfemg/yunxiang-newapi-compensation/main/install.sh) --install
```

此选项保留已有配置和令牌，不删除任何数据；已经标记为 `started` 或 `ready` 的部署缺少账本时仍停止。迁移已有数据使用 `--migrate`，不要把已有账本遗失当成新安装。

## 无人值守部署

先把 云中猫API小站 管理令牌保存到仅管理员可读的 `/root/newapi-admin-token`，再执行：

```bash
export NEWAPI_URL=https://newapi.example.com
export NEWAPI_ADMIN_USER_ID=1
export NEWAPI_ADMIN_TOKEN_FILE=/root/newapi-admin-token
export PUBLIC_ORIGIN=https://refund.example.com
export COMPENSATION_PORT=3210
bash <(curl -fsSL https://raw.githubusercontent.com/wanfemg/yunxiang-newapi-compensation/main/install.sh) --non-interactive
```

## 彻底卸载

卸载前如需保留账本，先按“持久化与备份”导出备份。确认不再保留数据后，在服务器执行：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wanfemg/yunxiang-newapi-compensation/main/uninstall.sh)
```

交互模式需要输入 `彻底卸载` 确认。确认后删除云响专属容器 `yunxiang-compensation`、Compose 项目 `newapi-compensation`、本地镜像 `yunxiang-newapi-compensation:local`、账本数据卷 `newapi-compensation_compensation_data`、宿主机 secrets 和安装目录（默认 `/opt/yunxiang`）。命令不修改 云中猫API小站 容器、网络、数据库、反向代理或 TLS 证书。

已进入安装菜单时也可选择 `4. 彻底卸载`。下载式入口只取同版本卸载脚本，不下载和覆盖整套源码。`--non-interactive` 本身不会确认删除，无人值守卸载必须显式加 `--yes`：

```bash
YUNXIANG_INSTALL_DIR=/opt/yunxiang bash <(curl -fsSL https://raw.githubusercontent.com/wanfemg/yunxiang-newapi-compensation/main/uninstall.sh) --yes
```

自定义安装目录必须设置 `YUNXIANG_INSTALL_DIR`。卸载脚本拒绝 `/`、`/opt`、`/home` 等高危路径；目录存在但缺少云响标识文件时同样拒绝删除。

卸载先确认 Docker 引擎可用，精确检查云响容器归属，再删除云响资源；容器、卷或镜像删除失败时保留安装目录并报错，不会显示卸载成功。安装、迁移和卸载共用同一目标目录锁，避免并发操作。

## 自动适配

同机 Docker 自动适配使用 `NEWAPI_CONTAINER` 指定容器，不设置 `NEWAPI_URL`。多个网络使用 `NEWAPI_NETWORK`，非默认内部端口使用 `NEWAPI_PORT`。管理 ID、令牌缺失时安装报错退出，不生成猜测的凭据。更新读取已有配置，当前 shell 的原站地址、管理 ID 和域名不会覆盖接入设置。

- 从运行中容器名称、镜像、启动命令和 Compose service 识别 NewAPI 主体，排除补偿工具、代理、worker 等附属服务；多个候选必须明确选择，不盲选。
- 读取所选主体的 Compose 项目名、工作目录、编排文件列表和数据挂载来源；数据库按主体的实际连接地址关联容器，不按数据库默认端口随意挑选。
- Docker/Compose 自定义 bridge 网络：复用容器现有网络及内部 PORT，不挂载原站数据库。
- Docker host 网络：云响也使用 host 网络，原站连接宿主机回环地址。
- 未发现容器：输入主机服务或远程 云中猫API小站 根地址；云响以 host 网络容器运行。用 `NEWAPI_URL` 显式指定地址可跳过容器猜测；`NEWAPI_CONTAINER` 可指定容器。
- 只连接默认 bridge 的原站，自动读取发布到 `127.0.0.1` 或 `0.0.0.0` 的对应 TCP 端口，以 host 模式连接；未发布对应端口时要求使用 `NEWAPI_URL`，不会擅自修改原站网络。
- 首次输入云响端口、HTTPS Origin、站长 ID 和管理令牌。令牌隐藏输入，不能自动猜取。端口默认仅本机监听，域名仍需代理到本地端口。
- 识别 `SQL_DSN`、`DATABASE_URL`、`DB_DSN`、独立日志库 `LOG_SQL_DSN` 及其文件型配置；支持 MySQL、PostgreSQL、SQLite 与 ClickHouse 日志库。SQLite 同时解析容器内路径和持久化挂载。受限识别文件仅保存脱敏后的类型、位置和项目关联，不保存 DSN、数据库账号或密码。
- 数据库识别与验证分开显示。数据库端口检查从所选 NewAPI 的网络环境发起，仅代表 TCP 可达，不代表数据库账号认证或表结构已验证；原站 SQLite 仅检查文件可读性和文件头，不写原数据库。云响自己的账本绑定预检在临时副本中读取，保留 WAL，不在只读原卷上创建 SHM。主机服务或远程 API 模式不声称读取了数据库文件。日志与补款始终走 云中猫API小站 API，不直改原站主库或日志库。

自动安装使用 `.env.auto`、`compose.generated.json`，不自动覆盖旧 `.env.docker` 配置。已有手动部署应先停止旧云响再切换入口并核对 NEWAPI_URL；命名卷同为 `newapi-compensation_compensation_data`，严禁双开或 `down -v`。远程接口 URL 不同也会触发账本实例绑定校验。

## 重新获取 NewAPI 项目与数据库

原站容器重建、更换 Compose 目录或调整数据库挂载后，重新运行一键入口，选择 `5. 重新获取 NewAPI 项目与数据库`。直接执行对应操作：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wanfemg/yunxiang-newapi-compensation/main/install.sh) --refresh-newapi
```

本地入口为 `bash install.sh --refresh-newapi`；`--rediscover`、`--reconnect` 和 `--mode refresh` 与此等效。仅对已有完整云响部署执行重新关联，首次安装仍选择安装 / 更新。

重新获取会重新枚举主体候选、Compose 文件来源、主库、日志库、数据挂载和网络，不继续使用过期的容器缓存。存在多个原站或多个网络时必须明确选择；无人值守时使用 `NEWAPI_CONTAINER`、`NEWAPI_NETWORK`、`NEWAPI_PORT` 明确指定，无法唯一定位时退出。

新配置先保存在临时区域，从拟使用的云响网络检查管理身份与配置 ID、日志、用户额度读取、用户组、渠道与模型目录，再单独报告数据库位置和连通性。检查只读，不创建申请、不发放测试额度。普通管理员受到原站同级保护时，会报告本人额度读取结果和未验证的目标用户读取能力；公开状态接口不兼容会单独提示。

检查失败保留原接入配置和账本；通过后才发布关联配置并复查服务。常规安装 / 更新继续使用已保存的关联，不会因为服务器出现另一个 NewAPI 就切换实例。重新获取也不用于把旧补偿账本关联到另一套数据库：检测到主库或日志库改变时拒绝切换；接口 Origin 仅因同一项目重建而更名时，必须先证明仍使用同一 Docker 引擎下的相同持久数据库，才允许同步账本中的绑定地址。不同服务器或 Docker 引擎的同名卷不作为同一实例证据。旧版本仅保存数据库类型或缺少引擎身份时，只允许保持原地址补齐识别信息，不自动放宽更名绑定检查。

整站迁移后仍沿用原 API 地址、数据库识别字段也保持一致时，允许刷新当前引擎信息，账本绑定地址保持不变；这不作为允许后续跨地址重新绑定的迁移证明。

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

生产启动自动创建 `/app/data/compensation.sqlite`，WAL 模式。包含规则、原消费与申请快照、唯一请求索引、发放账本、查询缓存、审计事件及通知队列。不是 云中猫API小站 原数据库，也不是临时日志文件。设置页显示持久化状态；演示预览使用内存且明确标记。

```bash
cd /opt/yunxiang
docker compose --env-file .env.auto -f compose.generated.json exec -T compensation node src/backup.mjs
docker compose --env-file .env.auto -f compose.generated.json logs --tail 100 compensation
```

备份命令创建 SQLite 在线一致性快照，拒绝覆盖文件并执行 quick_check；快照位于持久卷 `/app/data/backups/`，仍需转存到独立受限存储，不是异地备份。另备份同卷 `secrets.key`、`dingtalk.enc` 以及宿主机 secrets、部署配置。禁止直接复制在线主文件而遗漏 WAL。恢复必须停止应用、对账、禁用执行后进行；旧快照可能缺少已发放记录。

## 更新

再次运行下载式入口下载源码并重建镜像，不删除数据卷，不覆盖 secrets 和既有部署配置。镜像构建会运行后端测试，上线后只读预检验证管理身份、日志、用户额度读取及规则关联接口，不发放额度。健康检查不代表真实补款与通知均已验证。更新原站项目或数据库定位使用菜单第 5 项，常规更新不会暗中覆盖已有接入设置。

仅使用本地已下载的源码时，`bash install.sh` 会重新构建当前源码；需要获取仓库新版本时重新运行上方下载式命令。构建在暂停旧服务之前完成，构建失败时旧服务继续运行；文件校验或权限修复失败会保留旧账本并尝试恢复原容器，恢复失败会明确报出。重新安装使用无缓存构建并强制重建云响容器。修复数据权限后以应用 UID 1000 实际验证可写，再启动服务，避免迁移后的只读 SQLite 重启循环。接入检查失败不会输出部署成功。

## 跨服务器迁移

云响账本在 Docker named volume `newapi-compensation_compensation_data`，只复制源码目录不会迁移数据。旧服务器执行 `bash migrate.sh export yunxiang-migration.tar.gz`，把迁移包传到新服务器的云响源码目录后执行 `bash migrate.sh import yunxiang-migration.tar.gz`，最后运行 `bash install.sh`。

导出会暂时停止云响写入容器，复制完整账本、WAL 和加密密钥，完成或失败后恢复原来运行的容器。导入先验证压缩包路径、链接、配置、SQLite 完整性和通知密钥，随后创建卷；目标已有部署或数据卷时拒绝覆盖。只读备份缺少 SHM 时在临时副本中验证 SQLite，不向备份源写入。

从旧容器恢复到新卷时，复制和目标校验通过后，新卷成为唯一写入账本；后续启动失败不会再恢复旧容器向旧账本写入，重新运行会继续使用恢复卷。复制失败时只撤回本次新建、且没有容器引用的未完成卷；无法撤回时保留所有数据并报错。

导入会恢复数据卷、`.env.auto`、`compose.generated.json` 和宿主机 secrets；不会恢复镜像，也不会覆盖已有数据卷。手动把账本放到当前目录 `data/`（包含 SQLite 及同目录 WAL/SHM 文件）或现存 `yunxiang-compensation` 容器的 `/app/data` 时，安装器会自动恢复到持久卷，不需要再执行导入。新服务器缺少原外部网络时，安装器会按当前 云中猫API小站 容器重新识别网络，无法唯一识别时用 `NEWAPI_NETWORK` 指定。迁移自检发现旧绝对路径会自动改写为当前安装目录。数据卷缺失且没有任何可恢复账本时安装会停止，不会新建空账本冒充迁移成功。

Logo 从 云中猫API小站 `/api/status` 的 `logo` 读取，站内路径由后端同源代理；外部 HTTPS Logo 由浏览器无 referrer 加载。缺失或加载失败保留默认云朵图标。
