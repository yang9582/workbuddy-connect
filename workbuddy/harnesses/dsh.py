"""DeepSeek Harness（DSH）适配器：检查/升级官方 dsh-workbuddy-connect 插件。"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import List

from .base import HarnessAdapter

TARGET_VERSION = "0.7.9"


class DshAdapter(HarnessAdapter):
    name = "dsh"
    label = "DeepSeek Harness"
    note = "插件文件替换后需要重启 DSH 才会加载"

    @property
    def dsh_home(self) -> Path:
        return Path.home() / ".dsh"

    def plugin_dirs(self) -> List[Path]:
        home = self.dsh_home / "profiles"
        if not home.is_dir():
            return []
        return [
            child / "node_modules" / "dsh-workbuddy-connect"
            for child in sorted(home.iterdir())
            if child.is_dir() and (child / "node_modules" / "dsh-workbuddy-connect").is_dir()
        ]

    def detect(self) -> bool:
        return bool(self.plugin_dirs())

    def _version(self, path: Path) -> str:
        try:
            return str(json.loads((path / "package.json").read_text(encoding="utf-8")).get("version", ""))
        except Exception:
            return ""

    def status(self):
        info = super().status()
        plugins = [{"path": str(path), "version": self._version(path)} for path in self.plugin_dirs()]
        info["plugins"] = plugins
        info["configured"] = any(item["version"] == TARGET_VERSION for item in plugins)
        heartbeat = self.dsh_home / ".workbuddy-host-heartbeat.json"
        try:
            info["heartbeat"] = json.loads(heartbeat.read_text(encoding="utf-8"))
        except Exception:
            info["heartbeat"] = None
        return info

    def install(self, manager, *, profiles: str = "", dry_run: bool = False) -> List[str]:
        vendored = self.repo_root() / "vendor" / "dsh-workbuddy-connect"
        if not (vendored / "package.json").exists():
            return [
                "未找到 vendor/dsh-workbuddy-connect；请手动升级：",
                f"  npm install dsh-workbuddy-connect@{TARGET_VERSION}（在 ~/.dsh/profiles/<profile> 下）",
            ]
        lines: List[str] = []
        for plugin_dir in self.plugin_dirs():
            current = self._version(plugin_dir)
            if current == TARGET_VERSION:
                lines.append(f"[{plugin_dir.parent.parent.name}] 已是 {current}")
                continue
            if dry_run:
                lines.append(f"[{plugin_dir.parent.parent.name}] 将升级 {current} -> {TARGET_VERSION}")
                continue
            for old in (plugin_dir / "lib").glob("host-heartbeat-*.js"):
                old.unlink()
            for item in vendored.iterdir():
                target = plugin_dir / item.name
                if item.is_dir():
                    if target.exists():
                        shutil.rmtree(target)
                    shutil.copytree(item, target)
                else:
                    shutil.copy2(item, target)
            lines.append(f"[{plugin_dir.parent.parent.name}] 已升级 {current or '?'} -> {TARGET_VERSION}")
        if not dry_run:
            lines.append("重启 DSH：taskkill /F /IM \"DeepSeek Harness.exe\" 后重新打开")
        return lines
