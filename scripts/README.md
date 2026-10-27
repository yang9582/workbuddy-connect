# scripts/（历史脚本）

此目录为早期版本的入口，已不再维护，也不属于当前支持范围。

当前用法请使用仓库根目录的 `README.md` 与 `python -m workbuddy.cli_main --help`：

| 脚本 | 现状 |
|---|---|
| `install.py` | 已弃用；DSH 安装请使用 `wbconnect dsh bundle` |
| `uninstall.py` | 已弃用；请使用 `wbconnect dsh restore` 与 `wbconnect stop` |
| `patch_dsh_plugin.py` | 已弃用；仅用于将旧补丁改过的文件恢复为原版 |

保留这些文件仅用于旧版本回滚。
