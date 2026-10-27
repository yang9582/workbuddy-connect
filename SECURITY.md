# 安全说明

WorkBuddy Connect 是一个本机工具：它在本地复用 WorkBuddy 桌面应用的登录态，并以本地 HTTP
接口的形式向 DSH 提供模型。它不连接第三方服务器，也不上传对话或凭据。令牌会保存在本机，
请了解以下边界。

## 数据位置

| 位置 | 内容 | 敏感度 |
|---|---|---|
| `%LOCALAPPDATA%\hermes-workbuddy-bridge\config.json` / `config.ai.json` | 端口、变体、本地 Bearer 令牌 | 高：可据此调用桥接 |
| 同目录 `logs/`、`state/` | 运行日志、模型目录缓存、探测结果 | 中 |
| `~/.dsh/.env` | 同一令牌的副本（供 DSH 读取） | 高 |
| `state/last-anthropic-*.json` | 仅在 `WORKBUDDY_BRIDGE_DUMP=1` 时写入，含请求体 | 高：属于对话内容 |

WorkBuddy 自身的登录凭据保留在 WorkBuddy 客户端目录中，本项目只读取，不复制、不上传。

## 信任边界

- 桥接仅监听 `127.0.0.1`，不监听局域网地址。
- 除 `/v1/api/hello` 外的接口均要求 Bearer 令牌（`timingSafeEqual` 比较），同时接受
  `Authorization: Bearer` 与 `x-api-key`。
- **CORS 仅对本地来源回发**：`file://`、`app://`、`null`（Electron 渲染进程）与
  `localhost` / `127.0.0.1`；外部页面无法读取响应。
- 桥接不做账号级授权：**能读取 `config.json` 的本机进程均可调用它**。这是本地工具的固有
  限制，建议保持数据目录的默认权限，不要共享本机账号。

## 加固建议

1. 不要修改默认绑定地址，也不要用端口转发将 `39621` / `39622` 暴露到局域网。
2. 定期检查数据目录是否存在 `last-anthropic-*.json`，确认 `WORKBUDDY_BRIDGE_DUMP` 未常开。
3. 换机或怀疑泄露时，删除 `config*.json` 后重启桥接以轮换令牌，并重新执行 `dsh bundle`。
4. 卸载时清理 `~/.dsh/.env` 中写入的令牌。

## 报告问题

发现安全问题请勿公开提交 issue，请使用仓库的 *Security → Report a vulnerability*
（私有安全公告），并附版本、复现步骤与影响范围。请勿在报告中粘贴真实令牌或对话内容。
