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
- `python -m workbuddy.cli_main install --harness dsh` 会在每个 profile 的
  `cordis.patch.yml` 末尾追加一段受管配置：
  - `llm-pi-ai.providers.workbuddy` / `workbuddy-ai` → `http://127.0.0.1:3962x/v1`，
    `api: openai-completions`，模型列表来自桥接 `/v1/models`（静态声明）；
  - `llm-workbuddy.disabled: true`（仅当该 profile 装了官方插件时写），避免同一批模型出现两组。
- 令牌写入 `~/.dsh/.env` 的 `WORKBUDDY_BRIDGE_TOKEN` / `WORKBUDDY_AI_BRIDGE_TOKEN`
  （DSH 启动时会加载该文件，pi-ai 的 `apiKeyEnv` 从这里取值）。
- **重启 DSH 后生效**：模型选择器里出现 WorkBuddy / WorkBuddy AI 分组。
- **不再修改 `~/.dsh/profiles/*/node_modules`**。2.1 之前的历史版本给官方插件打过补丁，
  那些文件是 pnpm 全局 store 的硬链接，原地改写会污染 store；用
  `python -m workbuddy.cli_main dsh restore` 可恢复成 `vendor/` 里的原版（先删后拷，断开硬链接）。
- 回滚：`wbconnect uninstall --harness dsh` 移除受管配置；`.workbuddy-backup` 是写入前的备份。
- 离线校验（不启动 DSH）：
  ```
  "D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile web --dump-config
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
| `endpoint [--show-token]` | 打印 OpenAI 兼容端点（令牌默认打码） |
| `sync [--profiles all] [--reprobe] [--no-probe]` | 刷新 Hermes provider |
| `install --harness all\|hermes,claude,codex,openclaw,dsh,generic` | 安装/配置 |
| `uninstall --harness …` | 移除配置 |
| `harnesses` | 列出支持的 harness 与检测结果 |
| `kernel [--refresh]` | 查看桥接内核来源；`--refresh` 从已安装插件重新提取并验证导出 |
| `dsh [status\|restore]` | DSH 接入状态；把旧版补丁改过的插件文件恢复原版 |
| `doctor` / `logs` | 自检 / 日志 |

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

端口优先级：`WORKBUDDY_BRIDGE_PORT` 环境变量 > 配置文件 > 默认 39621。
插件启动桥接时会同时传环境变量并校正配置文件，改端口不再需要手工删 `config.json`。

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
| DSH 模型选择器里没有 WorkBuddy 分组 | 先重启 DSH；再看 `wbconnect dsh status`（`managed: true`）；`~/.dsh/.env` 里要有 `WORKBUDDY_BRIDGE_TOKEN`；桥接需在跑（`wbconnect start`） |
| 401 | 目标 profile 的 `.env` 缺令牌：`hermes workbuddy sync --profiles <名字>`；DSH 则是 `~/.dsh/.env` 缺令牌，重跑 `install --harness dsh` |

## 9. 开发与验证

```bash
cd "D:\Program Files\workbuddy-connect"
python -m compileall -q workbuddy __init__.py
python -m unittest discover -s tests -t . -v          # Python 单测（标准库 unittest）
node --test bridge/test/system-policy.test.mjs bridge/test/kernel.test.mjs
python -m workbuddy.cli_main status
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
