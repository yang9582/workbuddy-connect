"""Codex CLI 适配器：在 ~/.codex/config.toml 追加受管理的 provider/profile 块。"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List

from .base import HarnessAdapter

BEGIN = "# >>> workbuddy-connect (managed; wbconnect install codex) >>>"
END = "# <<< workbuddy-connect (managed) <<<"


class CodexAdapter(HarnessAdapter):
    name = "codex"
    label = "Codex CLI"
    note = "用 `codex --profile workbuddy` 或把 model_provider 改成 workbuddy 后使用"

    @property
    def config_path(self) -> Path:
        return Path.home() / ".codex" / "config.toml"

    def detect(self) -> bool:
        return self.config_path.exists()

    def _block(self, endpoint, models) -> str:
        model_lines = ",\n".join(
            f'  {{ model = "{model}", display_name = "{model}" }}' for model in models
        )
        return (
            f"{BEGIN}\n"
            "[model_providers.workbuddy]\n"
            'name = "WorkBuddy (local bridge)"\n'
            f'base_url = "{endpoint["base_url"]}"\n'
            'wire_api = "chat"\n'
            "requires_openai_auth = false\n"
            f'experimental_bearer_token = "{endpoint["token"]}"\n'
            f"models = [\n{model_lines}\n]\n\n"
            "[profiles.workbuddy]\n"
            'model_provider = "workbuddy"\n'
            f'model = "{endpoint["model"]}"\n'
            f"{END}\n"
        )

    def install(self, manager, *, profiles: str = "", dry_run: bool = False) -> List[str]:
        endpoint = self.endpoint(manager)
        models = endpoint["models"] or [endpoint["model"]]
        text = self.config_path.read_text(encoding="utf-8") if self.config_path.exists() else ""
        text = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", text, flags=re.S).rstrip()
        block = self._block(endpoint, models)
        if dry_run:
            return [f"将向 {self.config_path} 追加 provider/profile 块（{len(models)} 个模型）"]
        new_text = (text + "\n\n" if text else "") + block
        self.write_text(self.config_path, new_text)
        return [
            f"已写入 {self.config_path}",
            f"  provider workbuddy -> {endpoint['base_url']}",
            f"  使用：codex --profile workbuddy（或把 model_provider 改成 \"workbuddy\"）",
        ]

    def uninstall(self, manager) -> List[str]:
        if not self.config_path.exists():
            return ["Codex: 没有 config.toml"]
        text = self.config_path.read_text(encoding="utf-8")
        new_text = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", text, flags=re.S).rstrip() + "\n"
        self.write_text(self.config_path, new_text)
        return [f"已从 {self.config_path} 移除 workbuddy 块"]

    def status(self):
        info = super().status()
        found = False
        base = ""
        if self.config_path.exists():
            text = self.config_path.read_text(encoding="utf-8", errors="replace")
            found = BEGIN in text
            match = re.search(r'base_url = "([^"]+)"', text)
            base = match.group(1) if match else ""
        info.update({"config": str(self.config_path), "configured": found, "base_url": base})
        return info
