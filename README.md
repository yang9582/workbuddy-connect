# WorkBuddy Connect

把 WorkBuddy / WorkBuddy AI 桌面版的模型接入 **DeepSeek Harness（DSH）**。

项目由两部分组成：本地桥接负责复用 WorkBuddy 的登录态并提供 OpenAI 兼容接口；DSH 插件负责
注册模型分组、生成上下文窗口与推理档位配置。**本项目仅支持 DSH。**

![license](https://img.shields.io/badge/license-MIT-blue)
![python](https://img.shields.io/badge/python-3.10%2B-3776AB)
![node](https://img.shields.io/badge/node-18%2B-339933)
![platform](https://img.shields.io/badge/platform-Windows%20tested-lightgrey)
![tests](https://img.shields.io/badge/tests-78%20Python%20%7C%2046%20Node-brightgreen)

> English: A local bridge plus an installable plugin that exposes WorkBuddy desktop models to
> DeepSeek Harness (DSH). DSH only.

## ✨ 亮点

| 亮点 | 说明 |
|---|---|
| **上下文窗口默认取最大值** | 按上游声明的可选窗口取最大值（国际版最高 1M），支持按模型覆盖或回退上游默认值。 |
| **推理档位自动补齐** | 优先采用上游声明的档位；未声明的模型按配置补齐 `low` / `medium` / `high`。 |
| **模型权限预检** | 生成配置前逐模型探测，账号无权访问（`11158`）的模型不写入 provider。 |
| **指纹策略集中处理** | 上游对 system prompt 的指纹校验统一在桥接层处理（`defang` / `neutral` / `pass`）。 |
| **本地优先** | 仅监听 `127.0.0.1`，Bearer 鉴权，CORS 只对本地来源放行，不经过第三方服务器。 |
| **可诊断** | `doctor --all` 覆盖桥接、provider 与插件部署；配置写入具备事务性，日志自动轮转。 |

## 🖼️ 界面预览

<p align="center">
  <img src="docs/screenshots/preview-3.png" alt="WorkBuddy Connect 在 DSH 中的界面" width="720" />
</p>
<p align="center">
  <img src="docs/screenshots/preview-1.png" alt="WorkBuddy Connect 在 DSH 中的界面" width="240" />
  <img src="docs/screenshots/preview-2.png" alt="WorkBuddy Connect 在 DSH 中的界面" width="240" />
</p>

## 🚀 快速开始

### 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| **WorkBuddy 桌面版** | 已安装并登录（国内版 / 国际版任一或都装） | 桥接复用其登录态 |
| **Python** | 3.10+ | 运行 `wbconnect`（仅用标准库） |
| **Node.js** | 18+ | 桥接运行时 |
| **DeepSeek Harness** | 0.2.1-rc.x（已验证 rc.3） | 目标宿主 |

### 安装步骤

```bash
git clone https://github.com/yang9582/workbuddy-connect.git workbuddy-connect
cd workbuddy-connect

# 1) 启动本地桥接（国内版 39621 / 国际版 39622）
python -m workbuddy.cli_main start

# 2) 确认登录态与模型数
python -m workbuddy.cli_main status

# 3) 生成 DSH 配置：写入 provider、上下文窗口、推理档位，
#    同时把桥接令牌写入 ~/.dsh/.env
python -m workbuddy.cli_main dsh bundle
```

4）在 DSH 的「插件」页安装本地包，指向 `dsh/workbuddy-connect/`，然后重启 DSH。

安装完成后，模型选择器中会出现 **WorkBuddy / WorkBuddy AI** 分组。

> **插件不能单独安装。** 模型列表与令牌由本地桥接按当前账号生成；跳过 `dsh bundle`
> 会出现"插件已安装但没有可用模型"。

桥接默认在打开 DSH 后自动启动（可用 `WORKBUDDY_NO_AUTOSTART=1` 关闭）。如需登录时即启动：

```bash
wbconnect autostart install     # 安装
wbconnect autostart status      # 查看
wbconnect autostart uninstall   # 取消
```

自检：

```bash
python -m workbuddy.cli_main doctor --all
```

> 下文用 `wbconnect` 简写 `python -m workbuddy.cli_main`（需在仓库根目录执行）。
> 也可将 `bin/` 加入 `PATH` 后直接使用（Windows 为 `bin\wbconnect.cmd`）。

## 🧩 DeepSeek Harness

DSH 侧以可安装的 bundle 形式提供，安装后出现在「插件」页，可启用、停用与卸载。

```bash
# 生成或刷新 bundle（按当前账号的模型目录写入 provider、窗口与档位）
python -m workbuddy.cli_main dsh bundle
```

然后在「插件」页安装本地包（指向 `dsh/workbuddy-connect/`）。

> 仓库仅包含模板 `cordis.patch.example.yml`。DSH 实际读取的 `cordis.patch.yml` 按账号生成，
> 含模型清单，已由 `.gitignore` 排除。

安装后提供：

1. **模型分组**：`WorkBuddy` / `WorkBuddy AI`，经本地桥接调用；
2. **积分条**：选中 WorkBuddy 模型时，输入框工具行左侧显示剩余积分（悬停查看套餐，可刷新）；
3. **模型菜单倍率**：模型行附加倍率与促销标记；
4. **设置页**：账号、登录态、令牌有效期、积分、套餐与完整模型表；
5. **上下文窗口**：默认取模型可选的最大窗口，设置页可见生效值与可选项；
6. **推理档位**：目录声明优先，未声明的模型补齐三档；
7. **图片输入**：上游声明支持图片的模型会标记为多模态，可直接在对话中附加图片。

生成策略在桥接配置中（`%LOCALAPPDATA%\hermes-workbuddy-bridge\config.json` /
`config.ai.json`），修改后重新执行 `dsh bundle` 并重启 DSH：

| 键 | 作用 |
|---|---|
| `contextWindowPolicy` | `max`（默认，取可选最大窗口）/ `default`（上游当前窗口） |
| `contextWindowOverrides` | 按模型指定窗口，如 `{"hy4-preview": 500000}` |
| `effortPolicy` | `force`（默认，未声明档位也写三档）/ `declared`（仅写入有依据的档位） |
| `effortForceLevels` | 强制写出时使用的档位，默认 `["low","medium","high"]` |
| `effortOverrides` | 按模型指定档位，如 `{"glm-5.3": ["low","high","max"]}` |

> DSH 的 `llm-pi-ai` 配置中每个模型只能声明一个 `contextWindow`，因此窗口选择通过配置完成，
> 而不是界面下拉。上游目录中可选窗口仅国际版提供，国内版为固定窗口。

### 安装前后自查

```bash
# 离线校验：组合 profile 并打印结果（不启动 DSH）
"<DSH 安装目录>/resources/runtime/cli/bin/dsh.cmd" --profile web --dump-config

# 运行中的插件路由是否就绪
curl http://127.0.0.1:<DSH 端口>/workbuddy/status
```

## 🛠️ CLI

```bash
python -m workbuddy.cli_main <command>
```

| 命令 | 作用 |
|---|---|
| `status` | 桥接状态、登录态与模型数 |
| `start` / `stop` / `restart` | 启停桥接实例 |
| `models [--instance]` | 列出模型 |
| `probe --effort [--reprobe]` | 探测哪些模型校验 `reasoning_effort` |
| `endpoint [--show-token]` | 输出 OpenAI 兼容端点（令牌默认脱敏） |
| `dsh [status\|bundle\|restore]` | DSH 状态、生成 bundle、恢复旧补丁 |
| `autostart [status\|install\|uninstall]` | 登录时自启（Windows 启动文件夹） |
| `doctor` / `doctor --all [--json]` | 桥接自检 / 端到端检查 |
| `kernel [--refresh]` | 桥接内核来源与哈希 |
| `logs` | 查看桥接日志 |

## ⚙️ 配置

### 桥接配置（数据目录）

`%LOCALAPPDATA%\hermes-workbuddy-bridge\config.json` / `config.ai.json`：

- `port` / `variant` / `token` / `catalogRefreshMinutes` / `creditsCacheSeconds`
- `systemPolicy`：`pass` / `defang` / `neutral`（默认按协议面取值：OpenAI 国内版 `defang`、
  国际版 `pass`；Anthropic 面 `neutral`）
- `systemBlockedPhrase` / `systemSafePhrase` / `neutralSystemPrompt` / `neutralMinLength`
- `anthropicSystemMode`（旧键，优先级更高）、`anthropicDefaultModel`、`modelAliases`
- 生成策略：`contextWindowPolicy`、`contextWindowOverrides`、`effortPolicy`、
  `effortForceLevels`、`effortOverrides`

端口优先级：`WORKBUDDY_BRIDGE_PORT` 环境变量 > 配置文件 > 默认 `39621`。

### 安全与日志

- **CORS 仅放行本地来源**：`file://`、`app://`、`null`（Electron 渲染进程）与
  localhost / 127.0.0.1；其他页面无法读取响应。
- **调试转储默认关闭**：完整请求体仅在 `WORKBUDDY_BRIDGE_DUMP=1` 时写入 `state/`；
  `WORKBUDDY_BRIDGE_DEBUG=1` 仅影响日志详细程度。
- **日志轮转**：启动前将超过 5MB 的日志重命名为 `<name>.1`。
- **探测限流**：并发 2，遇到 429 退避 1.5 秒重试一次；仍失败记为"未验证"。

## 🩺 自检

```bash
python -m workbuddy.cli_main doctor --all          # 表格输出；失败时退出码 1
python -m workbuddy.cli_main doctor --all --json   # 供脚本使用
```

覆盖：桥接监听、healthz、登录态、本地令牌、内核哈希、system 策略、模型探测
（可用 / 无权限 / 未验证）、DSH 部署（bundle、patch、旧补丁残留）、版本漂移与运行时依赖。

## 🔧 故障排查

| 现象 | 处理 |
|---|---|
| `11128 request illegal / unapproved channel` | system prompt 命中上游指纹：确认内核版本为 0.7.9+，将 `systemPolicy` 设为 `defang`（国内版默认），然后 `wbconnect restart` |
| `11158 not allowed for user type` | 该模型不在账号套餐内；重启桥接重新探测后，重新执行 `dsh bundle` |
| `WorkBuddy 内核契约不匹配` | `wbconnect kernel` 查看记录，`wbconnect kernel --refresh` 重新提取并校验导出 |
| `502 transport error: fetch failed` | 本机到 `www.workbuddy.ai` 不通（代理或 DNS）；恢复后 `wbconnect restart` |
| DSH 中没有 WorkBuddy 分组 | 重启 DSH；`wbconnect dsh status` 查看 `mode`；确认 `~/.dsh/.env` 中存在 `WORKBUDDY_BRIDGE_TOKEN` |
| 输入框左侧没有积分条 | 访问 `/workbuddy/status` 确认插件路由；必要时刷新页面或重启 DSH |
| 模型菜单未显示倍率 | 该文案由插件前端接管，刷新页面或重启 DSH 以加载新版本 |
| 推理档位缺失 | 默认补齐三档；检查 `effortPolicy` 是否为 `declared`，或模型是否提供 `reasoning` 字段 |
| 无法定位问题 | `wbconnect doctor --all` |

## 🧪 开发与测试

```bash
python -m compileall -q workbuddy __init__.py
python -m unittest discover -s tests -t . -v          # Python：78 项
node --test bridge/test/*.test.mjs                    # 桥接：31 项
node --test dsh/workbuddy-connect/test/*.test.mjs     # bundle：15 项
python -m workbuddy.cli_main doctor --all
```

仓库结构：

```
workbuddy/            Python 核心：进程管理、CLI、DSH 适配器
bridge/               Node 桥接：OpenAI + Anthropic 协议、目录与积分、system 策略
dsh/workbuddy-connect DSH bundle：声明式 patch + Host 半 + Client 半
vendor/               第三方内核与离线包（见 THIRD_PARTY_NOTICES.txt）
tests/                单元测试（标准库 unittest）
```

## ⚠️ 限制与免责声明

- **仅支持 DSH**：本项目面向 DeepSeek Harness，其他客户端不在支持范围内。仓库中保留的早期
  客户端适配代码与清单仅用于回滚，不再维护。
- **非官方项目**：与 WorkBuddy、腾讯、DeepSeek 均无关联，未获其背书。
- **依赖非公开接口**：桥接复用 WorkBuddy 桌面客户端的登录态与私有接口，客户端大版本更新后
  可能失效；届时需更新 `bridge/vendor/host-bundle.js`（`wbconnect kernel --refresh`）。
- **平台**：目前仅在 Windows 上验证；macOS / Linux 未验证。
- **桥接需常驻**：打开 DSH 时会自动尝试启动（`WORKBUDDY_NO_AUTOSTART=1` 可关闭）。启动失败时
  模型仍会出现在选择器中，但调用会失败，此时手动执行 `wbconnect start` 即可。
- **界面能力有限**：DSH 不支持按 provider 程序化注册模型，因此模型显隐与窗口下拉由配置替代。
- **合规使用**：请自行确认符合 WorkBuddy 服务条款与所在地法规，勿用于账号共享或规避计费。
- **无担保**：按 MIT 协议「AS IS」提供，使用风险自负。

## 📄 许可与第三方

- 本项目：[MIT](LICENSE)。
- `bridge/vendor/host-bundle.js` 与 `vendor/dsh-workbuddy-connect/` 来自
  [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT，© Corrine Hu），
  详见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
- 安全说明见 [SECURITY.md](SECURITY.md)，参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。
