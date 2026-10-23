"""harness 适配器基类与共用工具。"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from .. import providers_sync, service


class HarnessAdapter:
    """一个 agent harness 的安装/卸载适配器。"""

    name = ""
    label = ""
    #: install() 后需要用户手动完成的事情（打印在总结里）
    note = ""

    # ── 子类实现 ────────────────────────────────────────────
    def detect(self) -> bool:
        raise NotImplementedError

    def install(self, manager: service.BridgeManager, *, profiles: str = "", dry_run: bool = False) -> List[str]:
        raise NotImplementedError

    def uninstall(self, manager: service.BridgeManager) -> List[str]:
        return [f"{self.label}: 没有可回滚的配置"]

    def status(self) -> Dict[str, Any]:
        return {"harness": self.name, "label": self.label, "detected": self.detect()}

    # ── 公共工具 ────────────────────────────────────────────
    @property
    def home(self) -> Path:
        return Path.home()

    def repo_root(self) -> Path:
        """仓库根目录（本包的上一级）。"""
        return Path(__file__).resolve().parents[2]

    def endpoint(self, manager: service.BridgeManager, key: str = "workbuddy-ai") -> Dict[str, Any]:
        """返回 {base_url, token, model, models, port, instance}。"""
        inst = next(i for i in service.INSTANCES if i.key == key)
        manager.ensure_dirs()
        token = manager.token(inst)
        if not token:
            manager.ensure(inst)
            token = manager.token(inst)
        models = manager.models(inst) if manager.is_port_open(manager.port(inst)) else []
        allowed_ids = self._allowed_ids(manager, inst, models)
        model = next((m for m in providers_sync.PROVIDER_DEFAULT_MODEL.get(key, ()) if m in allowed_ids), None)
        if model is None:
            model = allowed_ids[0] if allowed_ids else "default-model"
        return {
            "instance": key,
            "port": manager.port(inst),
            "base_url": f"http://127.0.0.1:{manager.port(inst)}/v1",
            "token": token,
            "model": model,
            "models": [ident for ident in allowed_ids],
        }

    def _allowed_ids(self, manager: service.BridgeManager, inst: service.Instance,
                     models: List[Dict[str, Any]]) -> List[str]:
        ids = [row["id"] for row in models]
        try:
            cache = json.loads(manager.probe_cache_path(inst).read_text(encoding="utf-8"))
            verdicts = cache.get("results") or {}
            if isinstance(verdicts, dict) and verdicts:
                ids = [i for i in ids if verdicts.get(i, "ok") != "blocked"] or ids
        except Exception:
            pass
        return ids

    def write_text(self, path: Path, text: str, *, backup: bool = True) -> Optional[Path]:
        """写文件；backup=True 时在首次修改前留一份 .workbuddy-backup。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        backup_path = None
        if backup and path.exists():
            backup_path = path.with_suffix(path.suffix + ".workbuddy-backup")
            if not backup_path.exists():
                shutil.copy2(path, backup_path)
        path.write_text(text, encoding="utf-8")
        return backup_path

    @staticmethod
    def read_json(path: Path, default: Any) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default

    @staticmethod
    def dump_json(path: Path, data: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @staticmethod
    def state_dir() -> Path:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "workbuddy-connect"
