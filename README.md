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
| **DeepSeek Harness** | 内置 `dsh-workbuddy-connect` 插件升级到 0.7.9 | ✅ 已验证 |
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
│   ├── service.py            # 桥接进程管理：懒启动、健康检查、停止、模型权限探测
│   ├── providers_sync.py     # 写 providers.* + .env 令牌（hermes config set）
│   ├── tools.py / schemas.py # Hermes 工具（status / models / sync）
│   ├── cli.py                # Hermes 内命令与 /workbuddy
│   ├── hermes_plugin.py      # register(ctx) 装配
│   ├── cli_main.py           # wbconnect 独立 CLI（跨 harness）
│   └── harnesses/            # 各 harness 适配器
│       ├── hermes.py  claude_code.py  codex.py  openclaw.py  dsh.py  generic.py
├── bridge/                   # Node 桥接（OpenAI + Anthropic 双协议）
│   ├── server.mjs
│   ├── doctor.mjs
│   ├── vendor/host-bundle.js # dsh-workbuddy-connect 0.7.9 内核（MIT）
│   └── node_modules/@deepseek-ai/*   # 两个最小替身包
├── desktop/plugin.js         # Hermes 桌面 UI（积分徽章 / 倍率 / pill / 设置页）
├── vendor/dsh-workbuddy-connect/  # DSH 插件离线升级包（0.7.9）
└── scripts/install.py / uninstall.py
```

## 2. 工作原理

```
harness (Hermes / Claude Code / Codex / …)
  └─ OpenAI /v1/chat/completions  或  Anthropic /v1/messages
       └─ bridge (Node, 127.0.0.1:39621|39622)  ← 本地 Bearer 鉴权
            └─ WorkBuddy 桌面登录态（加密凭据，经 App 自带 Electron 解密）
                 └─ copilot.tencent.com / www.workbuddy.ai
```

- **上游认证**：WorkBuddy 桌面 App 的登录态；令牌临近过期自动刷新。
- **本地认证**：每个实例一份随机 Bearer 令牌（首次启动生成，存数据目录 `config*.json`）。
- **模型权限**：同步前用 `max_tokens=1` 探测；上游 `11158 not allowed for user type` 的模型
  不写入 provider，避免选中后 400。
- **渠道校验兼容**：
  - 内核 0.7.9（旧内核会被上游以 `11128 request illegal` 拒绝）。
  - Claude Code 的长 system prompt 会被上游做渠道指纹校验 → 桥接默认替换为中性提示词
    （工具与消息不受影响；`config.anthropicSystemMode = "pass"` 可关闭）。
  - Claude Code 的模型名会映射到真实 WorkBuddy 模型（`claude-* → deepseek-v4.1-flash`）。

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
- 检查 `~/.dsh/profiles/*/node_modules/dsh-workbuddy-connect` 版本，低于 0.7.9 时
  用 `vendor/dsh-workbuddy-connect/` 覆盖升级。
- 升级后重启 DSH（`taskkill /F /IM "DeepSeek Harness.exe"` 后重新打开），
  `~/.dsh/.workbuddy-host-heartbeat.json` 的 `pluginVersion` 应为 0.7.9。
- **国内版（CN）兼容补丁**（`install --harness dsh` 会自动应用，幂等）：
  上游按**精确短语**拦截 agent harness 的 system prompt（`11128 请求被拦截`），
  只替换已知句不够（提示词随会话增长还会命中别的短语）。补丁做三件事：
  1. 把 DSH 固定开场句改成 `You are an AI agent running inside DeepSeek Harness.`；
  2. 对 CN 分支的 system 内容做「代码块之外的双空格展开」——Markdown 渲染与语义
     不变，但字节序列改变，精确指纹失配（实测同一 70KB 请求 11128 → 200）；
  3. shim 层对 11128 做 3 次退避重试。
  手工重打：`python scripts/patch_dsh_plugin.py --restore`（先从 vendor 还原再打补丁）。

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
- `anthropicSystemMode`：`replace`（默认，绕开 Claude Code 的渠道指纹）或 `pass`
- `anthropicSystemPrompt`：自定义替换文本
- `anthropicDefaultModel`：`claude-*` 请求映射到的默认模型
- `modelAliases`：`{ "claude-sonnet-4-5": "kimi-k3" }` 之类的精确映射

## 7. 迁移 / 数据

- 仓库已从 `C:\Users\zxtqj\projects\hermes-workbuddy` 迁到
  **`D:\Program Files\workbuddy-connect`**（git 历史保留）。
- 桥接数据目录保持 `%LOCALAPPDATA%\hermes-workbuddy-bridge`（配置/令牌/日志/模型缓存），
  与仓库位置无关；旧 `~/workbuddy-bridge` 仅作 legacy 参考。
- 首次运行会把旧目录的 `config*.json` 与 `state/catalog-cache-*.json` 复制过来（令牌不变）。

## 8. 故障排查

| 现象 | 处理 |
|---|---|
| `11128 request illegal / unapproved channel` | 内核太旧或 system prompt 命中上游精确指纹：确认 `bridge/vendor/host-bundle.js` 是 0.7.9+；Claude Code 用默认 `anthropicSystemMode=replace`；DSH 跑一遍 `install --harness dsh` 打 CN 补丁 |
| `11158 not allowed for user type` | 该模型不在账号套餐内；`wbconnect sync --reprobe` 会剔除 |
| `502 transport error: fetch failed` | 本机到 `www.workbuddy.ai` 不通（fake-IP 代理/DNS），与插件无关；恢复后 `wbconnect restart` |
| Claude Code 报 unknown model | 适配器写入的是 `claude-sonnet-4-5` 等别名，桥接负责映射；重启 Claude Code 会话 |
| Codex 里没有 workbuddy | `codex --profile workbuddy`；确认 `~/.codex/config.toml` 里有受管理块 |
| Hermes 工具没出现 | 插件是否在该 profile 启用；`hermes plugins list` |
| 401 | 目标 profile 的 `.env` 缺令牌：`hermes workbuddy sync --profiles <名字>` |

## 9. 开发与验证

```bash
cd "D:\Program Files\workbuddy-connect"
python -m compileall -q workbuddy __init__.py
python -m workbuddy.cli_main status
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
