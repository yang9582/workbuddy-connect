"""harness 适配器注册表。"""

from __future__ import annotations

from .base import HarnessAdapter
from .claude_code import ClaudeCodeAdapter
from .codex import CodexAdapter
from .dsh import DshAdapter
from .generic import GenericAdapter
from .hermes import HermesAdapter
from .openclaw import OpenClawAdapter

ADAPTERS: tuple[type[HarnessAdapter], ...] = (
    HermesAdapter,
    ClaudeCodeAdapter,
    CodexAdapter,
    OpenClawAdapter,
    DshAdapter,
    GenericAdapter,
)

REGISTRY: dict[str, type[HarnessAdapter]] = {cls.name: cls for cls in ADAPTERS}


def get(name: str) -> type[HarnessAdapter]:
    try:
        return REGISTRY[name]
    except KeyError:
        raise SystemExit(f"未知 harness: {name!r}（可用: {', '.join(REGISTRY)}）") from None


def detect_all() -> list[HarnessAdapter]:
    return [cls() for cls in ADAPTERS if cls().detect()]


__all__ = ["HarnessAdapter", "ADAPTERS", "REGISTRY", "get", "detect_all"]
