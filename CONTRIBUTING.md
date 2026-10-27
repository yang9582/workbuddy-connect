# 参与开发

这是一个个人项目，但欢迎 issue 与 PR。改之前建议先看 README 的「工作原理」和「开发与测试」。

## 环境

- Python **3.10+**（只用标准库，测试用 `unittest`）
- Node.js **18+**（桥接与测试用 `node:test`，无第三方依赖）

## 仓库地址、分支与认证

- 默认分支是 **`main`**（仓库里没有任何脚本或 CI 依赖分支名，改名/改分支不影响构建）。
- 克隆与推送两种方式都可以，按你的环境选：

```bash
# HTTPS（需要 PAT 或 gh auth login 的凭据）
git clone https://github.com/<owner>/workbuddy-connect.git

# SSH（推荐，避免代理/网络抖动时 HTTPS 被重置）
git clone git@github.com:<owner>/workbuddy-connect.git
```

- **仓库改名或转移后**，本地要更新远端地址，否则推送会落到旧路径（短期内 GitHub 会重定向，
  但旧用户名一旦被他人抢注，重定向就失效）：

```bash
git remote set-url origin git@github.com:<new-owner>/workbuddy-connect.git
git remote -v          # 确认
git fetch --prune
```

- 提交作者使用 `yang <103644627+yang9582@users.noreply.github.com>`（GitHub 的 **ID 型 noreply**）。
  这种地址跟账号 ID 绑定，**改用户名不会让历史提交失去归属**；换设备时执行一次即可：

```bash
git config user.name "yang"
git config user.email "103644627+yang9582@users.noreply.github.com"
```

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
| `workbuddy/` | Python 核心：进程管理、provider 生成、CLI 与 DSH 适配器 | 不在 `register()` 里做 IO |
| `bridge/` | Node 桥接：双协议、目录/积分、system 策略 | 新逻辑优先抽到 `bridge/lib/*.mjs` 并补单测 |
| `dsh/workbuddy-connect/` | DSH bundle：声明式 patch + Host/Client 半 | patch 改动必须能被 `dsh --dump-config` 组合 |
| `vendor/` | 第三方内核与离线包 | 改动需同步 `THIRD_PARTY_NOTICES.txt` |

## 提交约定

- 提交信息用中文、`type(scope): 摘要` 形式（`feat` / `fix` / `chore` / `docs`）。
- 一个提交只做一件事；附上验证方式（测试命令或实测结果）。
- **不要提交**个人路径、真实令牌、对话转储、`%LOCALAPPDATA%` 下的运行时文件，
  以及 `dsh/workbuddy-connect/cordis.patch.yml`（按账号生成的产物，已被 `.gitignore` 排除）。

## 发布

- Release 说明只记录**功能性变更**（新增、修复、行为变化），逐条写清影响面。
- 文档、措辞、元数据等非功能性修改不单列条目；这类版本写一句
  「文档修订版本，无功能变化。」即可。
- 版本号：功能性变更按语义化版本升级；纯文档修订升 patch。

## PR 检查清单

- [ ] `python -m unittest …` 与两组 `node --test` 全绿
- [ ] 改了桥接行为：补了单测，并在说明里写清对 DSH 侧的影响
- [ ] 改了 DSH patch/窗口/档位：附 `dsh --dump-config` 的验证结果
- [ ] 没有引入新的第三方许可依赖；有的话更新 `THIRD_PARTY_NOTICES.txt`
- [ ] README 里对应的命令/配置仍然准确
