"""通用 OpenAI 兼容适配器（豆包等其他 harness 的手动接入）。"""

from __future__ import annotations

from pathlib import Path
from typing import List

from .base import HarnessAdapter


class GenericAdapter(HarnessAdapter):
    name = "generic"
    label = "通用 OpenAI 兼容端点"
    note = "适用于豆包等支持「自定义模型 / OpenAI 兼容 API」的产品"

    def detect(self) -> bool:
        return True

    @property
    def endpoint_file(self) -> Path:
        return self.state_dir() / "endpoint.json"

    def install(self, manager, *, profiles: str = "", dry_run: bool = False) -> List[str]:
        endpoint = self.endpoint(manager)
        payload = {
            "type": "openai-compatible",
            "base_url": endpoint["base_url"],
            "api_key": endpoint["token"],
            "default_model": endpoint["model"],
            "models": endpoint["models"],
            "note": "任何支持自定义 OpenAI 兼容端点的 harness（豆包/OpenClaw/其它）都可以直接填这些值。",
        }
        if dry_run:
            return [f"将写入 {self.endpoint_file}"]
        self.dump_json(self.endpoint_file, payload)
        return [
            f"已写入 {self.endpoint_file}",
            f"  base_url: {endpoint['base_url']}",
            "  api_key / 模型列表见文件内容（仅本机可用）",
        ]
