"""模型可见的工具处理器（返回 JSON 字符串，永不抛出）。"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


def _ok(**payload: Any) -> str:
    return json.dumps({"success": True, **payload}, ensure_ascii=False)


def _err(message: str, **payload: Any) -> str:
    return json.dumps({"success": False, "error": message, **payload}, ensure_ascii=False)


def build_handlers(ctx, manager):
    """返回 {tool_name: handler}；handler 签名 ``(args, **kwargs) -> str``。"""

    def status(args: Dict[str, Any], **kwargs: Any) -> str:
        try:
            from . import providers_sync
            rows = [manager.status(inst, include_credits=True) for inst in manager.instances()]
            have = set(providers_sync.registered_providers())
            ready = {inst.key: inst.key in have for inst in manager.instances()}
            return _ok(instances=rows, provider_ready=ready)
        except Exception as exc:  # noqa: BLE001
            return _err(f"读取桥接状态失败: {exc}")

    def models(args: Dict[str, Any], **kwargs: Any) -> str:
        try:
            wanted = str(args.get("instance") or "all").strip()
            rows: Dict[str, Any] = {}
            errors: List[str] = []
            for inst in manager.instances():
                if wanted not in ("all", "", inst.key):
                    continue
                try:
                    manager.ensure(inst)
                    items = [
                        {
                            "id": row.get("id"),
                            "name": row.get("name"),
                            "context_length": row.get("context_length"),
                            **({"multiplier": row.get("multiplier")} if row.get("multiplier") else {}),
                        }
                        for row in manager.models(inst)
                    ]
                    rows[inst.key] = items
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{inst.key}: {exc}")
            payload: Dict[str, Any] = {"models": rows}
            if errors:
                payload["errors"] = errors
            return _ok(**payload) if rows else _err("; ".join(errors) or "没有可用的实例")
        except Exception as exc:  # noqa: BLE001
            return _err(f"列出模型失败: {exc}")

    def sync(args: Dict[str, Any], **kwargs: Any) -> str:
        try:
            from . import providers_sync
            spec = str(args.get("profiles") or "").strip() or None
            summary = providers_sync.sync(manager, explicit=spec)
            return _ok(**summary)
        except Exception as exc:  # noqa: BLE001
            return _err(f"同步 provider 失败: {exc}")

    return {"workbuddy_status": status, "workbuddy_models": models, "workbuddy_sync": sync}
