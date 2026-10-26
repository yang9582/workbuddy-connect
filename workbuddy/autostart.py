"""开机自启：在 Windows 的「启动」文件夹里放一个静默启动桥接的脚本。

不写注册表、不改计划任务，用户随时能在「启动」文件夹里看到并删除它——
误装也能手工清理，卸载命令同样会删除。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

SHORTCUT_NAME = "workbuddy-connect-bridge.vbs"

VBS_TEMPLATE = (
    'Set shell = CreateObject("WScript.Shell")\r\n'
    'shell.Run """{command}"" start", 0, False\r\n'
)


def supported() -> bool:
    return sys.platform.startswith("win")


def startup_dir() -> Path:
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def wrapper_path(repo_root: Path) -> Path:
    return repo_root / "bin" / "wbconnect.cmd"


def shortcut_path() -> Path:
    return startup_dir() / SHORTCUT_NAME


def status(repo_root: Path) -> dict:
    path = shortcut_path()
    return {
        "supported": supported(),
        "installed": path.is_file(),
        "shortcut": str(path),
        "target": str(wrapper_path(repo_root)),
    }


def install(repo_root: Path) -> dict:
    if not supported():
        return {"ok": False, "reason": "只有 Windows 支持自动创建启动项"}
    wrapper = wrapper_path(repo_root)
    if not wrapper.is_file():
        return {"ok": False, "reason": f"找不到 {wrapper}"}
    path = shortcut_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # VBS 用双引号包住命令，避免仓库路径里有空格（很常见）时被拆开
    path.write_text(VBS_TEMPLATE.format(command=str(wrapper)), encoding="utf-8")
    return {"ok": True, "shortcut": str(path), "target": str(wrapper)}


def uninstall() -> dict:
    path = shortcut_path()
    if not path.exists():
        return {"ok": True, "removed": False, "shortcut": str(path)}
    try:
        path.unlink()
    except OSError as exc:
        return {"ok": False, "reason": str(exc), "shortcut": str(path)}
    return {"ok": True, "removed": True, "shortcut": str(path)}
