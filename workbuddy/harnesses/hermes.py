"""Hermes Agent 适配器：把插件安装到各 profile 并注册 provider。"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any, Dict, List

from .. import __version__, providers_sync
from .base import HarnessAdapter

PLUGIN_ID = "workbuddy"
LEGACY_DESKTOP_ID = "workbuddy-status"
VERSION_MARKER = ".workbuddy-version"


class HermesAdapter(HarnessAdapter):
    name = "hermes"
    label = "Hermes Agent"

    # ── 路径 ────────────────────────────────────────────────
    def hermes_home(self) -> Path:
        env = os.environ.get("HERMES_HOME", "").strip()
        if env:
            return Path(env)
        if os.name == "nt":
            root = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
            return Path(root) / "hermes"
        return Path.home() / ".hermes"

    def profile_homes(self, spec: str = "") -> List[tuple[str, Path]]:
        base = self.hermes_home()
        targets: List[tuple[str, Path]] = [("default", base)]
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

    # ── 接口 ────────────────────────────────────────────────
    def detect(self) -> bool:
        return (self.hermes_home() / "config.yaml").is_file() or shutil.which("hermes") is not None

    def install(self, manager, *, profiles: str = "", dry_run: bool = False) -> List[str]:
        lines: List[str] = []
        repo = self.repo_root()
        for name, home in self.profile_homes(profiles):
            if not home.is_dir():
                lines.append(f"[{name}] 跳过：{home} 不存在")
                continue
            if dry_run:
                lines.append(f"[{name}] 将安装到 {home / 'plugins' / PLUGIN_ID}")
                continue
            dest = home / "plugins" / PLUGIN_ID
            if dest.exists():
                shutil.rmtree(dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(
                repo, dest,
                ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc", "scripts", "tests"),
            )
            # 版本标记：doctor 用它判断 profile 里的副本是否落后于仓库
            (dest / VERSION_MARKER).write_text(f"{__version__}\n", encoding="utf-8")
            # 桌面半：Electron 从 desktop-plugins 加载
            desktop_dir = home / "desktop-plugins" / PLUGIN_ID
            if desktop_dir.exists():
                shutil.rmtree(desktop_dir)
            desktop_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(repo / "desktop" / "plugin.js", desktop_dir / "plugin.js")
            legacy = home / "desktop-plugins" / LEGACY_DESKTOP_ID
            if legacy.exists():
                shutil.rmtree(legacy)
            status = "启用成功"
            try:
                # 走带超时的包装：hermes CLI 可能拉起常驻 runtime，超时后要结束整棵树，
                # 否则子进程继承 stdout 会让调用方永远等不到 EOF。
                result = providers_sync.run_hermes(
                    ["plugins", "enable", PLUGIN_ID],
                    None if name == "default" else name,
                    timeout=180,
                )
                if result.returncode != 0:
                    detail = (result.stderr or result.stdout or "").strip().splitlines()
                    status = "启用失败（手动: hermes plugins enable workbuddy）" + (f"（{detail[-1]}）" if detail else "")
            except Exception as exc:  # noqa: BLE001
                status = f"启用失败（{exc}）"
            lines.append(f"[{name}] 已安装 -> {dest}；{status}")
        if not dry_run:
            summary = providers_sync.sync(manager, explicit=(profiles or "all"))
            written = sum(len(v) for v in (summary.get("profiles") or {}).values())
            lines.append(f"provider 同步：{len(summary.get('profiles') or {})} 个 profile / {written} 条 provider")
        return lines

    def uninstall(self, manager) -> List[str]:
        lines: List[str] = []
        for name, home in self.profile_homes("all"):
            for path in (home / "plugins" / PLUGIN_ID, home / "desktop-plugins" / PLUGIN_ID):
                if path.exists():
                    shutil.rmtree(path)
                    lines.append(f"[{name}] 已删除 {path}")
        return lines

    def status(self) -> Dict[str, Any]:
        info = super().status()
        base = self.hermes_home()
        installed = (base / "plugins" / PLUGIN_ID / "plugin.yaml").is_file()
        marker = base / "plugins" / PLUGIN_ID / VERSION_MARKER
        installed_version = ""
        if marker.is_file():
            try:
                installed_version = marker.read_text(encoding="utf-8").strip()
            except Exception:
                installed_version = ""
        info.update({
            "home": str(base),
            "plugin_installed": installed,
            "configured": installed,
            "installed_version": installed_version,
            "repo_version": __version__,
            "stale": bool(installed and installed_version != __version__),
            "desktop_half": (base / "desktop-plugins" / PLUGIN_ID / "plugin.js").is_file(),
        })
        return info
