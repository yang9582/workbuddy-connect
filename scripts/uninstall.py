#!/usr/bin/env python3
"""卸载 hermes-workbuddy 插件。

顺序：停桥接 → 清理 provider/.env 令牌 → 删除各 profile 的插件目录与桌面 UI。
数据目录（%LOCALAPPDATA%\\hermes-workbuddy-bridge）不会自动删除。

用法：
    python scripts/uninstall.py
    python scripts/uninstall.py --profiles all
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

PLUGIN_ID = "workbuddy"


def hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME", "").strip()
    if env:
        return Path(env)
    if os.name == "nt":
        root = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(root) / "hermes"
    return Path.home() / ".hermes"


def target_homes(spec: str) -> list[tuple[str, Path]]:
    base = hermes_home()
    targets: list[tuple[str, Path]] = [("default", base)]
    spec = (spec or "").strip()
    if not spec:
        return targets
    if spec.lower() == "all":
        profiles = base / "profiles"
        if profiles.is_dir():
            for child in sorted(profiles.iterdir()):
                if child.is_dir() and (child / "config.yaml").is_file():
                    targets.append((child.name, child))
        return targets
    for name in [part.strip() for part in spec.split(",") if part.strip()]:
        targets.append((name, base / "profiles" / name))
    return targets


def run_hermes(args: list[str]) -> None:
    result = subprocess.run(
        ["hermes", *args], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if result.returncode == 0:
        print(f"  hermes {' '.join(args)}: OK")
    else:
        print(f"  hermes {' '.join(args)}: 跳过（{(result.stderr or result.stdout or '').strip()[:160]}）")


def main() -> int:
    parser = argparse.ArgumentParser(description="卸载 workbuddy 插件")
    parser.add_argument("--profiles", default="", help="all 或逗号分隔的 profile 名")
    parser.add_argument("--keep-providers", action="store_true", help="保留 provider 配置与 .env 令牌")
    args = parser.parse_args()

    if not args.keep_providers:
        run_hermes(["workbuddy", "stop"])
        spec = "all" if args.profiles.strip().lower() == "all" else (args.profiles or "current")
        run_hermes(["workbuddy", "cleanup", "--profiles", spec])

    for name, home in target_homes(args.profiles):
        plugin_dir = home / "plugins" / PLUGIN_ID
        desktop_dir = home / "desktop-plugins" / PLUGIN_ID
        for path in (plugin_dir, desktop_dir):
            if path.exists():
                shutil.rmtree(path)
                print(f"[{name}] 已删除 {path}")

    print()
    print("完成。数据目录仍保留：", Path(os.environ.get("LOCALAPPDATA", Path.home())) / "hermes-workbuddy-bridge")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
