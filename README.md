# WorkBuddy Connect

把本机 **WorkBuddy（国内版）** 与 **WorkBuddy AI（国际版）** 桌面应用的模型，接入多家
agent harness：**Hermes Agent、Claude Code、Codex CLI、OpenClaw、DeepSeek Harness（DSH）**，
以及任何支持「自定义 OpenAI 兼容端点」的产品（豆包等）。

一个仓库、一套桥接、多个安装适配器：

| Harness | 接入方式 | 状态 |
|---|---|---|
| **Hermes Agent** | 原生插件（3 个工具 + `on_session_start` + `/workbuddy`）+ 桌面 UI | ✅ 已验证 |
| **Claude Code** | 桥接提供 Anthropic 兼容 `/v1/messages`；写入 `~/.claude/settings.json` 的 `ANTHROPIC_*` | ✅ 已验证（含工具调用） |
| **Codex CLI** | 写入 `~/.codex/config.toml` 的 `model_providers.workbuddy` + `profiles.workbuddy` | ✅ 配置已验证 |
| **OpenClaw** | 写入 `~/.openclaw/workbuddy-connect.json`（在其设置里添加 OpenAI 兼容 provider） | ⚠️ 半自动 |
| **DeepSeek Harness** | profile 的 `cordis.patch.yml` 声明 OpenAI 兼容 provider（走本地桥接） | ✅ 已验证 |
| **豆包 / 其它** | `wbconnect endpoint` 输出 base_url / key / 模型列表，手填自定义模型 | ⚠️ 通用方案 |

> 个人自用项目。桥接依赖 WorkBuddy 客户端的**非公开接口**，WorkBuddy 大版本更新后可能需要
> 更新 `bridge/vendor/host-bundle.js`（见「维护」）。

---

## 1. 结构

```
workbuddy-connect/
├── plugin.yaml               # Hermes 清单（工具/钩子/设置 schema）
├── __init__.py               # Hermes 入口：from .workbuddy.hermes_plugin import register
├── workbuddy/
│   ├── service.py            # 桥接进程管理：端口一致性、懒启动、归属校验、模型权限探测
│   ├── providers_sync.py     # 写 providers.* + .env 令牌（hermes config set）
│   ├── kernel.py             # 桥接内核的来源追踪与刷新（kernel --refresh）
│   ├── tools.py / schemas.py # Hermes 工具（status / models / sync）
│   ├── cli.py                # Hermes 内命令与 /workbuddy
│   ├── hermes_plugin.py      # register(ctx) 装配
│   ├── cli_main.py           # wbconnect 独立 CLI（跨 harness）
│   └── harnesses/            # 各 harness 适配器
│       ├── hermes.py  claude_code.py  codex.py  openclaw.py  dsh.py  generic.py
├── bridge/                   # Node 桥接（OpenAI + Anthropic 双协议）
│   ├── server.mjs            # 路由 / SSE / 目录 / 积分 / 策略装配
│   ├── kernel.json           # 内核来源：版本、sha256、语义名→打包别名
│   ├── lib/kernel.mjs        # 内核契约守卫（缺导出时给可读错误）
│   ├── lib/system-policy.mjs # 统一的 system prompt 策略（pass/defang/neutral）
│   ├── lib/system-text.mjs   # system 文本清洗（剥 x-anthropic-billing-header）
│   ├── doctor.mjs
│   ├── test/*.test.mjs       # node --test，无第三方依赖
│   ├── vendor/host-bundle.js # dsh-workbuddy-connect 0.7.9 内核（MIT）
│   └── node_modules/@deepseek-ai/*   # 两个最小替身包
├── desktop/plugin.js         # Hermes 桌面 UI（积分徽章 / 倍率 / pill / 设置页）
├── dsh/workbuddy-connect/    # DSH bundle：声明式 patch + Host 半（/workbuddy/status）+ Client 半（积分/倍率）
├── vendor/dsh-workbuddy-connect/  # 0.7.9 原版（内核来源 + 旧补丁恢复用）
├── tests/                    # Python unittest（service / sync / dsh / kernel）
└── scripts/install.py / uninstall.py / patch_dsh_plugin.py（已弃用，转为恢复工具）
```

## 2. 工作原理

```
harness (Hermes / Claude Code / Codex / OpenClaw / DSH / …)
  └─ OpenAI /v1/chat/completions  或  Anthropic /v1/messages
       └─ bridge (Node, 127.0.0.1:39621|39622)  ← 本地 Bearer 鉴权
            └─ WorkBuddy 桌面登录态（加密凭据，经 App 自带 Electron 解密）
                 └─ copilot.tencent.com / www.workbuddy.ai
```

**所有 harness 现在走同一条链路**，包括 DSH（profile 配置声明 provider，不再改第三方插件）。

- **上游认证**：WorkBuddy 桌面 App 的登录态；令牌临近过期自动刷新（跨进程有文件锁）。
- **本地认证**：每个实例一份随机 Bearer 令牌（首次启动生成，存数据目录 `config*.json`）；
  桥接同时接受 `Authorization: Bearer` 与 `x-api-key`。
- **模型权限**：同步前用 `max_tokens=1` 探测；上游 `11158 not allowed for user type` 的模型
  不写入 provider，避免选中后 400。探测失败（超时/限流）会标为"未验证"而不是当成可用。
- **内核契约**：桥接依赖 `dsh-workbuddy-connect` 的打包产物，`bridge/kernel.json` 记录版本、
  哈希与"语义名 → 压缩别名"映射；缺导出时启动即给出可读错误，而不是 `SyntaxError`。
- **渠道校验兼容**：上游会对 agent harness 的 system prompt 做指纹校验（`11128`）。
  策略集中在桥接一处（`bridge/lib/system-policy.mjs`）：
  - `defang`（国内版默认）：替换已知被拦句 + 代码块外双空格展开，字节变、语义不变；
  - `neutral`（Anthropic 面默认）：长 system 整段替换为中性提示词（沿用旧的 replace 行为）；
  - `pass`：原样转发。
  Hermes / Codex / OpenClaw / DSH 与 Claude Code 现在共用同一套策略。
- **Claude Code 的模型名**会映射到真实 WorkBuddy 模型（`claude-* → deepseek-v4.1-flash`）。
- **推理内容**：非流式响应会把上游的 `reasoning_content` 合并进 `message.reasoning_content`
  （部分模型会先耗尽 token 预算推理，正文为空；丢掉推理内容时客户端只能看到空回复）。
  流式响应原样透传。
- **图片输入**：OpenAI 路径原样转发（是否支持取决于模型），桥接日志留一行提示；
  Anthropic 路径上游没有对应能力，图片块会被替换成文本占位，并在响应头
  `x-workbuddy-images: dropped` 标注。

## 3. 快速开始

```bash
cd "D:\Program Files\workbuddy-connect"

# 启动桥接（两个实例）
python -m workbuddy.cli_main start

# 安装到当前检测到的所有 harness（Hermes/Claude/Codex/OpenClaw/DSH）
python -m workbuddy.cli_main install --harness all

# 安装指定 harness
python -m workbuddy.cli_main install --harness claude,codex
```

Hermes 用户也可以用插件自带命令：

```bash
hermes workbuddy status          # 运行状态 / 登录态 / 账号可用模型数
hermes workbuddy sync            # 刷新当前 profile 的 provider
hermes workbuddy sync --profiles all
hermes workbuddy doctor
```

## 4. 各 harness 说明

### Hermes Agent
- 插件安装到 `$HERMES_HOME/plugins/workbuddy/`（默认 + `--profiles all` 的所有 bot profile），
  并启用、同步 provider。
- 桌面 UI 由 `desktop/plugin.js` 提供：状态栏积分、模型菜单倍率、输入框 pill、设置页。
- **重启桌面应用**后生效。

### Claude Code
- 桥接实现 Anthropic 兼容 `/v1/messages`（流式 + tool_use/tool_result + count_tokens）。
- 适配器写入 `~/.claude/settings.json`：
  ```
  ANTHROPIC_BASE_URL=http://127.0.0.1:39622      （不要带 /v1）
  ANTHROPIC_AUTH_TOKEN=<bridge token>
  ANTHROPIC_MODEL=claude-sonnet-4-5              （桥接映射到真实模型）
  ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5
  ```
- 原设置备份为 `settings.json.workbuddy-backup`，卸载时还原。
- 验证：`claude -p "只回复两个字：ok"`。

### Codex CLI
- 写入 `~/.codex/config.toml` 的受管理块：
  `[model_providers.workbuddy]`（base_url / wire_api="chat" / bearer token / models）
  与 `[profiles.workbuddy]`。
- 使用：`codex --profile workbuddy`（或把 `model_provider` 改成 `"workbuddy"`）。
- 原配置备份为 `config.toml.workbuddy-backup`。

### OpenClaw
- 写入 `~/.openclaw/workbuddy-connect.json`；OpenClaw 没有公开 provider API，
  需在其设置里手动添加「OpenAI 兼容 provider」（base_url / api_key / 模型）。

### DeepSeek Harness
两种接入形态，**装过 bundle 后以 bundle 为准**。

**A. bundle（推荐，会出现在 DSH 的「插件」页）**
- 包在 `dsh/workbuddy-connect/`：`package.json` + 声明式 `cordis.patch.yml`
  + 一对很小的 Host/Client 半（`index.js` / `client.js`）。
- 安装：在 DSH 的「插件」页安装本地包（指向该目录），或用 DSH 的
  `plugin_manager` `install_bundle`。装好后 DSH 记一条 `workbuddy-connect@2.1.0`
  （`source: link:…`），可启用/停用/卸载。
- 它做五件事：
  1. 给 `llm-pi-ai` 加两个 provider；
  2. 把官方插件 `llm-workbuddy` 关掉（装了才写）；
  3. **输入框下方显示剩余积分与模型倍率**（Host 半提供同源 `GET /workbuddy/status`，
     Client 半注册到 `conversation.composer.dock`；点数字展开套餐余量与倍率，可手动刷新）；
  4. **设置 → 插件 → WorkBuddy 页**：账号、登录态、令牌有效期、积分与更新时间、
     套餐余量、全量模型表（上下文 / 倍率 / 促销）；
  5. **模型选择器的菜单行显示倍率**：占用 `conversation.input.model.label`（同一席位服务
     trigger / 菜单当前值 / 每行 option），在 WorkBuddy 模型名后追加 `· x0.11 · 夜间折扣`；
     其它 provider 的模型名原样显示。
- Client 文案走 DSH 的 locale 服务（namespace `workbuddy`，中英两套字典，按当前语言注册并保留
  `en` 回退）；插件标题/描述在 `locale/{zh,en}.json` 的 `meta` 里。
- 积分只取一次、不轮询（每次查询都会真实打到计费接口）；菜单行共享同一次请求。
- **上下文窗口**按 `contextWindowPolicy` 写入（默认 `max`：取该模型可选窗口的最大值，例如
  国际版 hy4-preview 200K → 1M；改成 `default` 则用上游当前窗口）。单模型覆盖用
  `contextWindowOverrides: {"glm-5.3": 500000}`，优先级最高。设置页的「上下文」列会显示
  生效值与可选项，并标明当前策略。
  > DSH 的 `llm-pi-ai` 配置只能声明**一个** `contextWindow`，所以这里没有官方插件那种
  > "模型卡片里选窗口"的下拉——改桥接配置 → `wbconnect dsh bundle` → 重启 DSH。
  > 另外：上游目录只有**国际版**给可选窗口（`supportedContextWindows`，实测 11 个模型），
  > 国内版只有一个固定窗口，`max` 与 `default` 等价。
- 推理档位按优先级生成（`wbconnect dsh bundle` 时计算）：
  1. `effortOverrides`：桥接配置里的 `{"模型id": ["low","high"]}`，最高优先；
  2. 上游模型目录的 `reasoning.supportedEfforts`（权威，官方插件同源）；
  3. `wbconnect probe --effort` 对目录未声明模型的试探结果（缓存 7 天）；
  4. 以上都没有、但模型声明了 `reasoning.supports = true` → **默认强制写出 low/medium/high**，
     让选择器可用。桥接配置 `effortPolicy: "declared"` 可关闭强制，`effortForceLevels` 可改档位。
  实测：强制后国内版 **19/19**、国际版 **12/13** 个模型都有档位；唯一例外是没有 `reasoning`
  字段的 `default-model`。
  > 复核结论：hy3 / hy3-x / glm-5.2 / glm-5.1 / glm-5v-turbo / minimax-m3 / minimax-m2.7 /
  > kimi-k3-1 / mimo-v2.6-pro 的目录里确实**没有** `supportedEfforts`，内核自带的
  > `probeModel` 也把它们判为 `non-validating`（非法值被接受）。所以强制档位只保证"能选"，
  > 上游是否据此改变推理深度取决于其实现。
- 模型列表变化后重新生成：`wbconnect dsh bundle` → 重启 DSH。
- 卸载 bundle 就等于移除 provider、卡片与设置页（bundle 是唯一来源）。

> Host/Client 半是 JS 模块。替换已安装包的代码后，DSH 通常会用 HMR 重挂一次就生效
> （也可以 `plugin_manager set_plugin` 先 disable 再 enable）；若行为仍是旧版，重启 DSH。

**B. profile patch（没装 bundle 时的兜底）**
- `wbconnect install --harness dsh` 往各 profile 的 `cordis.patch.yml` 追加同样的受管块，
  适合不想动插件列表的场景；`wbconnect uninstall --harness dsh` 移除。

共同点：
- provider 指向 `http://127.0.0.1:3962x/v1`，`api: openai-completions`，
  模型列表来自桥接 `/v1/models`（静态声明）。
- 令牌写入 `~/.dsh/.env` 的 `WORKBUDDY_BRIDGE_TOKEN` / `WORKBUDDY_AI_BRIDGE_TOKEN`
  （DSH 启动时会加载该文件，pi-ai 的 `apiKeyEnv` 从这里取值）。
- **重启 DSH 后生效**：模型选择器里出现 WorkBuddy / WorkBuddy AI 分组。
- **不再修改 `~/.dsh/profiles/*/node_modules`**。2.1 之前的历史版本给官方插件打过补丁，
  那些文件是 pnpm 全局 store 的硬链接，原地改写会污染 store；用
  `wbconnect dsh restore` 可恢复成 `vendor/` 里的原版（先删后拷，断开硬链接）。
- 官方 `dsh-workbuddy-connect@0.7.9` 可以卸载：它要求 DSH `0.2.1-rc.2`，在 `rc.3` 上
  插件页会标 `incompatible-version`。卸载后重跑 `wbconnect dsh bundle` 可去掉关闭行。
- 离线校验（不启动 DSH）：
  ```
  "D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile web --patch dsh\workbuddy-connect\cordis.patch.yml --dump-config
  ```

### 豆包 / 其它
- `python -m workbuddy.cli_main endpoint --show-token` 输出 base_url / api_key / 模型列表，
  在支持自定义 OpenAI 兼容端点的产品里直接填。

## 5. wbconnect CLI

| 命令 | 作用 |
|---|---|
| `status` | 桥接状态 + 各 harness 配置状态 |
| `start` / `stop` / `restart` | 启停桥接实例 |
| `models [--instance]` | 列出模型 |
| `probe --effort [--reprobe]` | 探测哪些模型真正校验并接受 `reasoning_effort`（结果给 DSH bundle 用） |
| `endpoint [--show-token]` | 打印 OpenAI 兼容端点（令牌默认打码） |
| `sync [--profiles all] [--reprobe] [--no-probe]` | 刷新 Hermes provider |
| `install --harness all\|hermes,claude,codex,openclaw,dsh,generic` | 安装/配置 |
| `uninstall --harness …` | 移除配置 |
| `harnesses` | 列出支持的 harness 与检测结果 |
| `kernel [--refresh]` | 查看桥接内核来源；`--refresh` 从已安装插件重新提取并验证导出 |
| `dsh [status\|bundle\|restore]` | DSH 接入状态；生成/刷新 bundle 包；恢复旧补丁改过的插件文件 |
| `doctor` / `doctor --all [--json]` | 桥接自检 / 端到端检查（桥接、探测、各 profile、harness、bundle） |
| `logs` | 查看桥接日志（超过 5MB 启动时自动轮转到 `.1`） |

Hermes 内另有 `/workbuddy status|start|stop|sync|logs` 斜杠命令。

## 6. 配置

### Hermes 插件设置
`plugins.entries.workbuddy.settings.*`：`autostart`、`auto_sync`、`enable_cn`、`enable_ai`、
`port_cn`、`port_ai`、`data_dir`、`node_path`、`electron_bin_cn`、`electron_bin_ai`、
`probe_models`、`sync_profiles`。

### 桥接配置（数据目录）
`%LOCALAPPDATA%\hermes-workbuddy-bridge\config.json` / `config.ai.json`：
`port`、`variant`、`token`、`catalogRefreshMinutes`、`creditsCacheSeconds`，以及：

- `systemPolicy`：`pass` / `defang` / `neutral`，对所有协议面生效（不写则按面取默认值：
  OpenAI 国内版 `defang`、国际版 `pass`；Anthropic 面 `neutral`）
- `systemBlockedPhrase` / `systemSafePhrase`：被拦句与替换句（默认是 DSH 的开场句）
- `neutralSystemPrompt`：`neutral` 模式使用的提示词
- `neutralMinLength`：`neutral` 生效的最小字符数（默认 800，避免破坏短提示词）
- `anthropicSystemMode`：旧键，**仍优先于** `systemPolicy`（`replace` ≈ `neutral`）
- `anthropicSystemPrompt`：自定义替换文本（= `neutralSystemPrompt`）
- `anthropicDefaultModel`：`claude-*` 请求映射到的默认模型
- `modelAliases`：`{ "claude-sonnet-4-5": "kimi-k3" }` 之类的精确映射

### DSH 生成策略（每个实例的 `config*.json` 里可写）

| 键 | 作用 |
|---|---|
| `contextWindowPolicy` | `max`（默认，取可选窗口最大值）/ `default`（上游当前窗口） |
| `contextWindowOverrides` | `{"模型id": 500000}`，单模型指定窗口 |
| `effortPolicy` | `force`（默认，未声明档位的模型也写三档）/ `declared`（只写有依据的） |
| `effortForceLevels` | 强制写出时使用的档位，默认 `["low","medium","high"]` |
| `effortOverrides` | `{"模型id": ["low","high"]}`，单模型指定档位 |

改完执行 `wbconnect dsh bundle` 并重启 DSH。

端口优先级：`WORKBUDDY_BRIDGE_PORT` 环境变量 > 配置文件 > 默认 39621。
插件启动桥接时会同时传环境变量并校正配置文件，改端口不再需要手工删 `config.json`。

### 安全与日志

- **CORS 只放行本地来源**：`file://`、`app://`、`null`（Electron 渲染进程）与
  localhost / 127.0.0.1。其他网页拿不到 `Access-Control-Allow-Origin`，即使能发请求
  也读不到响应；非浏览器客户端（curl / pi-ai / Hermes 后端）不带 Origin，不受影响。
- **调试转储默认关闭**：完整 Anthropic 请求体（含 system prompt 与工具）只在
  `WORKBUDDY_BRIDGE_DUMP=1` 时写进 `state/last-anthropic-*.json`；
  `WORKBUDDY_BRIDGE_DEBUG=1` 只影响日志详细程度。
- **日志轮转**：每次启动桥接前，超过 5MB 的日志挪到 `<name>.1`（只保留一份）。
- **探测限流**：账号权限探测并发为 2，遇到 429 退避 1.5s 重试一次；
  仍失败的模型记为"未验证"，不会当成可用，也不会误判成无权限。

### 自检

```bash
python -m workbuddy.cli_main doctor --all          # 表格，失败时退出码 1
python -m workbuddy.cli_main doctor --all --json   # 给脚本用
```

检查项：桥接监听 / healthz / 登录态 / 本地令牌 / 内核哈希 / system 策略、
模型探测（可用 / 无权限 / 未验证）、每个 Hermes profile 的 provider 与 `.env` 令牌、
Claude Code / Codex / OpenClaw / DSH（bundle、旧补丁残留、官方插件）、
node 路径与 Hermes 桌面插件。

## 7. 迁移 / 数据

- 仓库已从 `C:\Users\zxtqj\projects\hermes-workbuddy` 迁到
  **`D:\Program Files\workbuddy-connect`**（git 历史保留）。
- 桥接数据目录保持 `%LOCALAPPDATA%\hermes-workbuddy-bridge`（配置/令牌/日志/模型缓存），
  与仓库位置无关；旧 `~/workbuddy-bridge` 仅作 legacy 参考。
- 首次运行会把旧目录的 `config*.json` 与 `state/catalog-cache-*.json` 复制过来（令牌不变）。

## 8. 故障排查

| 现象 | 处理 |
|---|---|
| `11128 request illegal / unapproved channel` | 上游按 system prompt 指纹拦截：确认 `bridge/vendor/host-bundle.js` 是 0.7.9+，并把配置里的 `systemPolicy` 设为 `defang`（国内版默认）；Claude Code 用默认的 `neutral`。改完 `wbconnect restart` |
| `WorkBuddy 内核契约不匹配` | 内核被打包成另一版布局：`wbconnect kernel` 看记录，`wbconnect kernel --refresh` 重新提取；失败时按提示人工重映射导出别名 |
| `11158 not allowed for user type` | 该模型不在账号套餐内；`wbconnect sync --reprobe` 会剔除 |
| `502 transport error: fetch failed` | 本机到 `www.workbuddy.ai` 不通（fake-IP 代理/DNS），与插件无关；恢复后 `wbconnect restart` |
| Claude Code 报 unknown model | 适配器写入的是 `claude-sonnet-4-5` 等别名，桥接负责映射；重启 Claude Code 会话 |
| Codex 里没有 workbuddy | `codex --profile workbuddy`；确认 `~/.codex/config.toml` 里有受管理块 |
| Hermes 工具没出现 | 插件是否在该 profile 启用；`hermes plugins list` |
| DSH 模型选择器里没有 WorkBuddy 分组 | 先重启 DSH；`wbconnect dsh status` 看 `mode`（`bundle` / `profile-patch`）；`~/.dsh/.env` 里要有 `WORKBUDDY_BRIDGE_TOKEN`；桥接需在跑（`wbconnect start`） |
| DSH 插件页看不到 workbuddy-connect | 它默认没装；`wbconnect dsh bundle` 生成包，再到 DSH 插件页安装本地包（装好是 `link:` 到仓库目录） |
| 不确定哪一环坏了 | `wbconnect doctor --all`：逐项给出桥接/探测/provider/部署/harness 状态与修复命令 |
| DSH 输入框下方没有积分卡片 | 卡片由 bundle 的 Client 半提供：确认插件页里 `workbuddy-connect` 已启用；用 `curl http://127.0.0.1:<DSH端口>/workbuddy/status` 确认 Host 半就绪；必要时 disable→enable 该插件或重启 DSH |
| DSH 模型菜单里模型名后没有倍率 | 该标签由 bundle 的 Client 半接管：**刷新页面**（或重启 DSH）加载新模块；自查 `curl http://127.0.0.1:<端口>/workbuddy/beacon` —— 有 `build` 与三个插槽的 `registered` 结果说明 Client 半已加载；`404` 说明 Host 半还是旧模块，需要重启 DSH |
| DSH 模型选择器里没有推理档位 | 默认会强制写出 low/medium/high；若仍没有，检查桥接配置是不是 `effortPolicy: "declared"`、模型是否有 `reasoning` 字段；改完 `wbconnect dsh bundle` 并重启 DSH |
| 401 | 目标 profile 的 `.env` 缺令牌：`hermes workbuddy sync --profiles <名字>`；DSH 则是 `~/.dsh/.env` 缺令牌，重跑 `install --harness dsh` |

## 9. 开发与验证

```bash
cd "D:\Program Files\workbuddy-connect"
python -m compileall -q workbuddy __init__.py
python -m unittest discover -s tests -t . -v          # Python 单测（标准库 unittest）
node --test bridge/test/*.test.mjs                    # 桥接单测（system-policy / kernel / cors / assemble）
node --test dsh/workbuddy-connect/test/*.test.mjs     # DSH bundle：Host 半裁剪 + Client 半注册/本地化
python -m workbuddy.cli_main status
python -m workbuddy.cli_main doctor --all             # 端到端自检（改了配置先跑这个）
python -m workbuddy.cli_main kernel                    # 内核来源与哈希
hermes plugins doctor .            # 仓库
hermes plugins doctor workbuddy    # 已安装副本

hermes --provider custom:workbuddy-ai -m deepseek-v4.1-flash chat -q "回复：ok"
claude -p "只回复两个字：ok"
```

## 10. 卸载

```bash
python scripts/uninstall.py --profiles all      # Hermes
python -m workbuddy.cli_main uninstall --harness claude,codex,openclaw
python -m workbuddy.cli_main stop
```

数据目录需手动删除；`~/.claude/settings.json.workbuddy-backup` 与
`~/.codex/config.toml.workbuddy-backup` 可作为手工回滚参考。

## 11. 许可

MIT（见 `LICENSE`）。`bridge/vendor/host-bundle.js` 与 `vendor/dsh-workbuddy-connect/`
来自 [dsh-workbuddy-connect](https://www.npmjs.com/package/dsh-workbuddy-connect)（MIT，作者
corrinehu），见 `THIRD_PARTY_NOTICES.txt`。依赖 WorkBuddy 客户端接口，仅供个人自用。
