# 参与开发

这是一个个人项目，但欢迎 issue 与 PR。改之前建议先看 README 的「工作原理」和「开发与测试」。

## 环境

- Python **3.10+**（只用标准库，测试用 `unittest`）
- Node.js **18+**（桥接与测试用 `node:test`，无第三方依赖）

## 常用命令

```bash
# 全量测试
python -m unittest discover -s tests -t . -v
node --test bridge/test/*.test.mjs
node --test dsh/workbuddy-connect/test/*.test.mjs

# 端到端自检（改完配置先跑这个）
python -m workbuddy.cli_main doctor --all

# 重新生成 DSH bundle（改了模型/窗口/档位策略后）
python -m workbuddy.cli_main dsh bundle
```

## 代码边界

| 目录 | 职责 | 注意 |
|---|---|---|
| `workbuddy/` | Python 核心：进程管理、provider 同步、CLI、harness 适配器 | 不在 `register()` 里做 IO |
| `bridge/` | Node 桥接：双协议、目录/积分、system 策略 | 新逻辑优先抽到 `bridge/lib/*.mjs` 并补单测 |
| `dsh/workbuddy-connect/` | DSH bundle：声明式 patch + Host/Client 半 | patch 改动必须能被 `dsh --dump-config` 组合 |
| `vendor/` | 第三方内核与离线包 | 改动需同步 `THIRD_PARTY_NOTICES.txt` |

## 提交约定

- 提交信息用中文、`type(scope): 摘要` 形式（`feat` / `fix` / `chore` / `docs`）。
- 一个提交只做一件事；附上验证方式（测试命令或实测结果）。
- **不要提交**个人路径、真实令牌、对话转储、`%LOCALAPPDATA%` 下的运行时文件。

## PR 检查清单

- [ ] `python -m unittest …` 与两组 `node --test` 全绿
- [ ] 改了桥接行为：补了单测，并在说明里写清楚对既有 harness 的影响
- [ ] 改了 DSH patch/窗口/档位：附 `dsh --dump-config` 的验证结果
- [ ] 没有引入新的第三方许可依赖；有的话更新 `THIRD_PARTY_NOTICES.txt`
- [ ] README 里对应的命令/配置仍然准确
