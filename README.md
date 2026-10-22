# WorkBuddy → Hermes 插件

把本机 **WorkBuddy（国内版）** 和 **WorkBuddy AI（国际版）** 桌面应用的模型，以 OpenAI 兼容
provider 的形式接入 [Hermes Agent](https://hermes-agent.nousresearch.com/docs)，
并在桌面端展示积分与模型倍率。

一个插件包同时提供三部分能力：

| 部分 | 入口 | 作用 |
|---|---|---|
| 后端桥接 | `bridge/server.mjs`（Node） | 复用 WorkBuddy 桌面登录态，在 `127.0.0.1` 暴露 `/healthz`、`/v1/models`、`/v1/credits`、`/v1/status`、`/v1/chat/completions`（SSE + 工具调用） |
| Hermes 插件 | `plugin.yaml` + `__init__.py` | 3 个工具、`on_session_start` 钩子、`hermes workbuddy` CLI、`/workbuddy` 斜杠命令、provider 注册与模型权限探测 |
| 桌面 UI | `desktop/plugin.js` | 状态栏积分徽章、模型菜单倍率、输入框模型 pill、设置页明细 |

> 个人自用项目。桥接依赖 WorkBuddy 客户端的**非公开接口**，WorkBuddy 大版本更新后可能需要
> 更新 `bridge/vendor/host-bundle.js`（见「维护」）。

---

## 1. 数据流

```
Hermes (LLM 调用)
  └─ provider: custom:workbuddy / custom:workbuddy-ai
       └─ http://127.0.0.1:39621|39622/v1/chat/completions   ← 本地 Bearer 鉴权
            └─ bridge (Node)：读取 WorkBuddy 桌面登录态（加密凭据，经 App 自带 Electron 解密）
                 └─ copilot.tencent.com / www.workbuddy.ai 的 chat completions
                      └─ SSE 流式返回，工具调用按 OpenAI 标准分片
```

- **上游认证**：WorkBuddy 桌面 App 的登录态；令牌临近过期由内核自动刷新。
- **本地认证**：每个桥接实例一份随机 Bearer 令牌（首次启动生成，存数据目录 `config*.json`）。
- **Hermes 侧密钥**：`providers.*.api_key` 存 `${WORKBUDDY_BRIDGE_TOKEN}` / `${WORKBUDDY_AI_BRIDGE_TOKEN}`
  占位符，真实令牌在**每个 profile 的 `.env`**，不落 `config.yaml`。
- **模型权限**：同步前用最小请求探测每个模型；上游 `11158 not allowed for user type` 的模型
  不写入 provider，避免选中后报 400。

## 2. 目录结构

```
hermes-workbuddy/
├── plugin.yaml            # 清单：工具、钩子、config_schema（桌面设置页据此渲染）
├── __init__.py            # register(ctx)：只注册，零副作用
├── service.py             # 进程/数据管理：懒启动、健康检查、停止、模型探测、旧目录迁移
├── providers_sync.py      # provider 注册 + .env 令牌同步（hermes config set）
├── tools.py               # 工具处理器（status / models / sync）
├── schemas.py             # 工具 schema
├── cli.py                 # hermes workbuddy ... 与 /workbuddy
├── desktop/plugin.js      # 桌面 UI（状态栏积分 / 倍率 / pill / 设置页）
├── bridge/                # Node 桥接载荷
│   ├── server.mjs         # OpenAI 兼容服务
│   ├── doctor.mjs         # 自检（凭据/登录态/模型/积分，不打印令牌）
│   ├── lib/dsh-env.mjs    # 读取 ~/.dsh/.env 的 WORKBUDDY* 变量
│   ├── vendor/host-bundle.js   # dsh-workbuddy-connect（MIT）宿主内核副本
│   └── node_modules/@deepseek-ai/*  # 两个最小替身包（原子写 / home 路径）
└── scripts/
    ├── install.py         # 安装到 Hermes（默认 profile，可选全部 profile）
    └── uninstall.py       # 停止、清理 provider、移除插件
```

## 3. 安装

要求：Windows / macOS / Linux，Hermes Agent 已装好，本机运行并登录 WorkBuddy 桌面 App，
PATH 里有 `node`（或稍后在设置里指定）。

```bash
# 默认 profile
python scripts/install.py

# 同时装到所有 bot profile（Bot Mode 的机器人）
python scripts/install.py --profiles all

# 或者手工：复制到 $HERMES_HOME/plugins/workbuddy，再
hermes plugins enable workbuddy
```

安装脚本会：

1. 把仓库复制到 `$HERMES_HOME/plugins/workbuddy/`（默认 profile）；
2. 把 `desktop/plugin.js` 同步到 `$HERMES_HOME/desktop-plugins/workbuddy/plugin.js`；
3. 删除旧的 `desktop-plugins/workbuddy-status/`（若存在）；
4. 执行 `hermes plugins enable workbuddy`。

### 首次使用

```bash
hermes workbuddy start     # 启动两个桥接实例（默认 39621 / 39622）
hermes workbuddy sync      # 探测模型权限 + 写入当前 profile 的 provider
hermes workbuddy status    # 运行状态 / 登录态 / 账号可用模型数
```

桌面应用在 **Settings → Plugins → workbuddy** 里有设置表单；模型菜单里会出现
WorkBuddy / WorkBuddy AI 两个分组。

## 4. 配置项

位置：`plugins.entries.workbuddy.settings.*`（`hermes config set` 或桌面设置页）。

| 键 | 默认 | 说明 |
|---|---|---|
| `autostart` | `true` | 会话开始时确保桥接运行（后台线程） |
| `auto_sync` | `true` | 模型目录/权限变化时自动刷新 provider |
| `enable_cn` / `enable_ai` | `true` | 启用国内版 / 国际版实例 |
| `port_cn` / `port_ai` | `39621` / `39622` | 本机端口 |
| `data_dir` | 空 | 数据目录；空 = `%LOCALAPPDATA%\hermes-workbuddy-bridge` |
| `node_path` | 空 | 空 = 自动探测（PATH → Hermes 自带 node → Program Files） |
| `electron_bin_cn` / `electron_bin_ai` | 空 | WorkBuddy 可执行文件；空 = 读 `~/.dsh/.env` 的 `WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN` |
| `probe_models` | `true` | 同步前探测账号权限，只写入可用模型 |
| `sync_profiles` | 空 | `all` / `current` / 逗号分隔的 profile；空 = 仅当前 profile |

## 5. 命令 / 工具 / 桌面 UI

| 命令 | 作用 |
|---|---|
| `hermes workbuddy status` | 两个实例的运行/登录/模型数 + 账号可用模型数（只读） |
| `hermes workbuddy start\|stop\|restart` | 托管进程 |
| `hermes workbuddy sync [--profiles all] [--reprobe] [--no-probe]` | 刷新 provider（默认探测权限） |
| `hermes workbuddy cleanup --profiles all` | 移除 provider 与 `.env` 令牌 |
| `hermes workbuddy logs --instance workbuddy-ai --lines 50` | 桥接日志 |
| `hermes workbuddy doctor` | 凭据/登录态/模型/积分自检 |
| `hermes workbuddy install --profiles all` | 复制并启用到其他 profile |
| `/workbuddy status\|start\|stop\|sync` | 会话内快捷入口 |

模型工具：`workbuddy_status`、`workbuddy_models`、`workbuddy_sync`。

桌面 UI：状态栏右侧积分徽章（点击展开套餐余量/优惠模型）、模型菜单每行倍率与促销徽章、
输入框模型名后的倍率、设置页明细与桥接目录选择。

## 6. 开发

```bash
# 校验清单 + 注册 + 工具声明（用临时 HERMES_HOME，不碰真实数据）
hermes plugins doctor "$PWD" --ci

# Python 语法
python -m compileall -q .

# Node 语法
node --check bridge/server.mjs && node --check bridge/doctor.mjs

# 端到端（桥接在跑的前提下）
hermes --provider custom:workbuddy -m glm-5.3-flash chat -q "回复：ok"
hermes --provider custom:workbuddy-ai -m deepseek-v4.1-flash chat -q "回复：ok"

# 工具调用
hermes -t workbuddy --provider custom:workbuddy -m glm-5.3-flash chat -q "调用 workbuddy_status"
```

改了 `desktop/plugin.js` 后，桌面端需要重载插件（设置 → 插件 → 重新加载，或重启桌面应用）。

## 7. 故障排查

| 现象 | 处理 |
|---|---|
| `找不到 node` | 装 Node.js 或设置 `node_path` |
| 端口被占用 | `hermes workbuddy stop`，或改端口 |
| 启动即退出 | `hermes workbuddy logs --lines 80`；常见是 Electron 路径不对 |
| `signIn.state != signed-in` | 打开 WorkBuddy 桌面 App 重新登录 |
| 上游 400 `11128 request illegal` / channel verification | 桥接内核落后于 WorkBuddy 客户端：按「维护」换成最新 `host-heartbeat-*.js` |
| 上游 400 `11158 not allowed for user type` | 该模型不在账号套餐内；`hermes workbuddy sync --reprobe` 会把它从 provider 里剔除 |
| 国际版 502 `transport error: fetch failed` | 本机到 `www.workbuddy.ai` 不通（fake-IP 代理/DNS 拦截），与插件无关；网络恢复后 `hermes workbuddy restart` |
| provider 里模型没出现 | `hermes workbuddy sync`；桌面端重启一次让模型菜单重读配置 |
| 模型调用 401 | 目标 profile 的 `.env` 缺令牌：对该 profile 跑 `hermes workbuddy sync --profiles <名字>` |
| 插件没加载 | `HERMES_PLUGINS_DEBUG=1 hermes plugins list`，或看 `logs/agent.log` 的插件 WARNING |

## 8. 维护：升级桥接内核

WorkBuddy 更新后，用 DSH 插件里的最新内核覆盖：

```bash
cp ~/.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-*.js \
   bridge/vendor/host-bundle.js
```

再核对 `server.mjs` / `doctor.mjs` 顶部的别名导入（`O`/`m`/`b`/`S`/`x`/`w`/`P`/`j`/`M`/`u`/`l`）
与内核文件末尾的 `export { ... as X }` 是否一致，然后 `hermes workbuddy restart`。

## 9. 移除

```bash
python scripts/uninstall.py            # 默认 profile
python scripts/uninstall.py --profiles all
```

手工顺序：`hermes workbuddy stop` → `hermes workbuddy cleanup --profiles all` →
`hermes plugins remove workbuddy`。数据目录 `%LOCALAPPDATA%\hermes-workbuddy-bridge`
（配置/令牌/日志/模型缓存）需手动删除。

## 10. 证书与第三方

- 本项目：MIT（见 `LICENSE`）。
- `bridge/vendor/host-bundle.js` 来自 [dsh-workbuddy-connect](https://www.npmjs.com/package/dsh-workbuddy-connect)
  （MIT，作者 corrinehu），见 `bridge/vendor/LICENSE` 与 `THIRD_PARTY_NOTICES.txt`。
- 依赖 WorkBuddy 客户端接口，仅供个人自用；请遵守 WorkBuddy 服务条款，风险自担。
