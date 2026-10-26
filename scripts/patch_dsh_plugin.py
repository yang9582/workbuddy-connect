#!/usr/bin/env python3
"""【已弃用】DSH 不再给第三方插件打补丁。

2.1 起 DSH 通过 profile 的 `cordis.patch.yml` 接入本机桥接（标准 OpenAI 兼容
provider），不再修改 `~/.dsh/profiles/*/node_modules` —— 那里的文件是 pnpm 全局
store 的硬链接，原地写入会污染 store，而且精确字符串锚点的补丁会随上游构建失效。

本脚本保留为**迁移工具**：把历史上被补丁改过的 `lib/index.js` 与
`host-heartbeat-*.js` 恢复成 `vendor/dsh-workbuddy-connect/` 里的原版。

用法：
    python scripts/patch_dsh_plugin.py                 # 恢复（等价于 wbconnect dsh restore）
    python scripts/patch_dsh_plugin.py --dry-run       # 只报告哪些文件带旧补丁
    python scripts/patch_dsh_plugin.py --dsh-home DIR  # 指定 DSH_HOME
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="恢复被旧版补丁改写的 dsh-workbuddy-connect 文件")
    parser.add_argument("--dsh-home", default="", help="DSH home（默认读 DSH_HOME 或 ~/.dsh）")
    parser.add_argument("--dry-run", action="store_true", help="只报告，不修改文件")
    parser.add_argument("--restore", action="store_true", help="（兼容旧参数，行为同默认）")
    args = parser.parse_args(argv)

    if args.dsh_home:
        os.environ["DSH_HOME"] = str(Path(args.dsh_home).expanduser())

    sys.path.insert(0, str(REPO))
    from workbuddy.harnesses.dsh import DshAdapter  # noqa: PLC0415

    adapter = DshAdapter()
    if args.dry_run:
        rows = adapter.status()
        if not rows.get("legacy_patched"):
            print("没有发现旧补丁残留")
            return 0
        for item in rows["legacy_patched"]:
            print(f"带旧补丁: {item}")
        print("\n运行 `python scripts/patch_dsh_plugin.py` 恢复原版")
        return 0

    lines = adapter.restore_legacy()
    for line in lines:
        print(line)
    print("\nDSH 现在走 cordis.patch.yml 里的 llm-pi-ai provider；插件文件恢复后无需重启（重启反而会用不到它）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
