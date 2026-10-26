# scripts/（历史脚本）

这里的脚本是早期版本的入口，**已经不再是推荐用法**：

| 脚本 | 现在请用 |
|---|---|
| `install.py` | `wbconnect install --harness hermes --profiles all` |
| `uninstall.py` | `wbconnect uninstall --harness hermes` + `wbconnect stop` |
| `patch_dsh_plugin.py` | `wbconnect dsh restore`（DSH 已改为声明式 bundle，不再给第三方插件打补丁） |

保留它们只是为了兼容旧文档与手动回滚。新版入口见仓库根目录的 `README.md` 与
`python -m workbuddy.cli_main --help`。
