"""OpenClaw 适配器。

OpenClaw 目前没有公开的 provider 插件 API；这里把端点信息写成一份标准 JSON，
放在其配置目录里，并给出在设置里添加「OpenAI 兼容 provider」的步骤。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List

from .base import HarnessAdapter


class OpenClawAdapter(HarnessAdapter):
    name = "openclaw"
    label = "OpenClaw"
    note = "OpenClaw 需要在设置里手动添加 OpenAI 兼容 provider；端点信息已写入 workbuddy-connect.json"

    @property
    def config_dir(self) -> Path:
        return Path.home() / ".openclaw"

    def detect(self) -> bool:
        return self.config_dir.is_dir()

    def install(self, manager, *, profiles: str = "", dry_run: bool = False) -> List[str]:
        endpoint = self.endpoint(manager)
        payload = {
            "provider": "workbuddy",
            "type": "openai-compatible",
            "base_url": endpoint["base_url"],
            "api_key": endpoint["token"],
            "default_model": endpoint["model"],
            "models": endpoint["models"],
            "note": "在 OpenClaw 设置里新增自定义 OpenAI 兼容 provider，填入以上 base_url / api_key / 模型。",
        }
        target = self.config_dir / "workbuddy-connect.json"
        if dry_run:
            return [f"将写入 {target}"]
        self.dump_json(target, payload)
        return [
            f"已写入 {target}",
            f"  base_url={endpoint['base_url']}",
            "  在 OpenClaw 设置里新增 OpenAI 兼容 provider（API Key 用文件里的 api_key）",
        ]

    def status(self):
        info = super().status()
        target = self.config_dir / "workbuddy-connect.json"
        info.update({"config": str(target), "configured": target.is_file()})
        return info
