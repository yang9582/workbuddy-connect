# 安全说明

WorkBuddy Connect 是一个**本机工具**：它复用你电脑上 WorkBuddy 桌面 App 的登录态，把模型
以本地 HTTP 接口的形式暴露给你自己的 agent harness。它不连接任何第三方服务器，也不上传
你的对话或凭据。但它确实会在本机保存令牌，所以请读一下下面的边界。

## 数据存在哪里

| 位置 | 内容 | 敏感度 |
|---|---|---|
| `%LOCALAPPDATA%\hermes-workbuddy-bridge\config.json` / `config.ai.json` | 端口、变体、**本地 Bearer 令牌** | 高：拿到即可调用你的桥接 |
| 同目录 `logs/`、`state/` | 运行日志、模型目录缓存、探测结果 | 中：日志可能含模型名与错误信息 |
| 各 harness 配置（Hermes `.env`、`~/.dsh/.env`、`~/.claude/settings.json`、`~/.codex/config.toml`） | 同一个本地令牌的副本 | 高 |
| `state/last-anthropic-*.json` | **仅在** `WORKBUDDY_BRIDGE_DUMP=1` 时写入，含完整 system prompt 与工具定义 | 高：属于对话内容 |

WorkBuddy 自己的登录凭据始终留在 WorkBuddy 客户端目录里，本项目只读取、不复制、不上传。

## 信任边界

- 桥接只监听 `127.0.0.1`，不监听局域网地址。
- 所有接口（除 `/v1/api/hello`）都要求 Bearer 令牌，比较用 `timingSafeEqual`；
  同时接受 `Authorization: Bearer` 与 `x-api-key`（兼容 Anthropic 风格客户端）。
- **CORS 只对本地来源回发**：`file://`、`app://`、`null`（Electron 渲染进程）与
  `localhost` / `127.0.0.1`。外部网页拿不到 `Access-Control-Allow-Origin`，读不到响应。
- 桥接自身不做账号鉴权之外的授权：**任何能读到 `config.json` 的本机进程/用户都能调用它**。
  这是本地工具的固有限制，也是为什么建议保持数据目录的默认权限、不要共享这台机器的账号。

## 已知取舍

- 令牌以**明文**保存在上述配置文件里（与 Hermes / DSH 的 `.env` 做法一致），没有做 DPAPI /
  Keychain 封装。请不要把这些文件提交到仓库、同步到网盘或贴进 issue。
- `WORKBUDDY_BRIDGE_DEBUG=1` 会输出更详细的日志（含请求体开头），排查完请关掉。
- 本项目依赖 WorkBuddy 客户端的**非公开接口**，上游随时可能变更；这不只是兼容性问题，
  也意味着上游可能改变对请求的校验方式。

## 加固建议

1. 不要修改默认绑定地址；不要用端口转发把 `39621/39622` 暴露到局域网。
2. 定期检查数据目录里是否有不该存在的 `last-anthropic-*.json`，有就删掉并确认
   `WORKBUDDY_BRIDGE_DUMP` 没有常开。
3. 换机或怀疑泄露时，删除 `config*.json` 后重启桥接即可轮换本地令牌，并重新
   `wbconnect sync` / `wbconnect dsh bundle` 让各 harness 拿到新令牌。
4. 卸载时记得清理各 harness 里写入的令牌（`wbconnect uninstall --harness …`）。

## 报告问题

发现安全问题请**不要**开公开 issue，改用 GitHub 仓库的 *Security → Report a vulnerability*
（私有安全公告）。请附上版本、复现步骤与影响范围；不要在报告里粘贴真实令牌或对话内容。
