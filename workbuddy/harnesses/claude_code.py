"""Claude Code 适配器：写入 ANTHROPIC_* 环境变量，指向桥接的 Anthropic 兼容端点。"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import List

from .base import HarnessAdapter

_ENV_KEYS = (
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
)


class ClaudeCodeAdapter(HarnessAdapter):
    name = "claude"
    label = "Claude Code"
    note = "重启 Claude Code 后生效；桥接由 wbconnect start 或 Hermes 会话自动拉起"

    @property
    def settings_path(self) -> Path:
        return Path.home() / ".claude" / "settings.json"

    @property
    def state_path(self) -> Path:
        return self.state_dir() / "claude-code.json"

    def detect(self) -> bool:
        return self.settings_path.exists() or shutil.which("claude") is not None

    def install(self, manager, *, profiles: str = "", dry_run: bool = False) -> List[str]:
        endpoint = self.endpoint(manager)
        # Claude Code 会自己在 base 后面追加 /v1/messages，所以 base_url 不能带 /v1
        anthropic_base = endpoint["base_url"][:-3] if endpoint["base_url"].endswith("/v1") else endpoint["base_url"]
        models = endpoint["models"]
        cheap = next((m for m in ("glm-5.3-flash", "fast-model", "hy3") if m in models), endpoint["model"])
        settings = self.read_json(self.settings_path, {}) or {}
        env = dict(settings.get("env") or {})
        state = self.read_json(self.state_path, {}) or {}
        if "original_env" not in state:
            state["original_env"] = {key: env[key] for key in _ENV_KEYS if key in env}
            self.dump_json(self.state_path, state)
        if dry_run:
            return [f"将写入 {self.settings_path}：ANTHROPIC_BASE_URL={endpoint['base_url']}，模型 {endpoint['model']}"]
        env.update({
            "ANTHROPIC_BASE_URL": anthropic_base,
            "ANTHROPIC_AUTH_TOKEN": endpoint["token"],
            # 用 Claude Code 认识的模型名（桥接会映射到真实 WorkBuddy 模型）
            "ANTHROPIC_MODEL": "claude-sonnet-4-5",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5",
            "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-sonnet-4-5",
        })
        settings["env"] = env
        self.write_text(self.settings_path, json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
        return [
            f"已写入 {self.settings_path}",
            f"  端点 {endpoint['base_url']}（Anthropic 兼容 /v1/messages）",
            f"  主模型 {endpoint['model']}；快速模型 {cheap}",
            "验证：claude -p \"只回复两个字：ok\"",
        ]

    def uninstall(self, manager) -> List[str]:
        settings = self.read_json(self.settings_path, {}) or {}
        env = dict(settings.get("env") or {})
        state = self.read_json(self.state_path, {}) or {}
        original = state.get("original_env") or {}
        for key in _ENV_KEYS:
            if key in original:
                env[key] = original[key]
            else:
                env.pop(key, None)
        if env:
            settings["env"] = env
        else:
            settings.pop("env", None)
        self.write_text(self.settings_path, json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
        if self.state_path.exists():
            self.state_path.unlink()
        return [f"已还原 {self.settings_path}"]

    def status(self):
        info = super().status()
        env = (self.read_json(self.settings_path, {}) or {}).get("env") or {}
        base = str(env.get("ANTHROPIC_BASE_URL", ""))
        info.update({
            "settings": str(self.settings_path),
            "base_url": base,
            "configured": "127.0.0.1:3962" in base,
            "model": env.get("ANTHROPIC_MODEL", ""),
        })
        return info
