#!/usr/bin/env python3
"""把 hermes-workbuddy 仓库安装为 Hermes 插件。

用法：
    python scripts/install.py                       # 默认 profile
    python scripts/install.py --profiles all        # 默认 + 所有 bot profile
    python scripts/install.py --profiles hacker,white-hat

安装内容：
    $HERMES_HOME/plugins/workbuddy/                 插件本体（后端 + bridge + desktop/）
    $HERMES_HOME/desktop-plugins/workbuddy/plugin.js 桌面 UI（供 Electron 端加载）
并清理旧的 workbuddy-status 桌面插件，最后执行 `hermes plugins enable workbuddy`。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLUGIN_ID = "workbuddy"
LEGACY_DESKTOP_ID = "workbuddy-status"


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


def install_plugin(home: Path) -> Path:
    dest = home / "plugins" / PLUGIN_ID
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        REPO, dest,
        ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc", "scripts"),
    )
    return dest


def install_desktop(home: Path) -> Path:
    dest_dir = home / "desktop-plugins" / PLUGIN_ID
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / "plugin.js"
    shutil.copy2(REPO / "desktop" / "plugin.js", target)
    legacy = home / "desktop-plugins" / LEGACY_DESKTOP_ID
    if legacy.exists():
        shutil.rmtree(legacy)
    return target


def enable(profile: str | None) -> None:
    cmd = ["hermes"]
    if profile:
        cmd += ["-p", profile]
    cmd += ["plugins", "enable", PLUGIN_ID]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    status = "OK" if result.returncode == 0 else "失败"
    print(f"  enable ({profile or 'default'}): {status}")
    if result.returncode != 0:
        print((result.stderr or result.stdout or "").strip()[:300])


def main() -> int:
    parser = argparse.ArgumentParser(description="安装 workbuddy 插件到 Hermes")
    parser.add_argument("--profiles", default="", help="all 或逗号分隔的 profile 名（默认只装当前 profile）")
    parser.add_argument("--no-enable", action="store_true", help="只复制文件，不执行 plugins enable")
    args = parser.parse_args()

    print(f"仓库: {REPO}")
    print(f"HERMES_HOME: {hermes_home()}")
    for name, home in target_homes(args.profiles):
        if not home.is_dir():
            print(f"[{name}] 跳过：{home} 不存在")
            continue
        plugin_dir = install_plugin(home)
        desktop_file = install_desktop(home)
        print(f"[{name}] 插件  -> {plugin_dir}")
        print(f"[{name}] 桌面  -> {desktop_file}")
        if not args.no_enable:
            enable(None if name == "default" else name)

    print()
    print("完成。下一步：")
    print("  hermes workbuddy start")
    print("  hermes workbuddy sync --reprobe")
    print("  hermes workbuddy status")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
