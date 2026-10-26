"""桥接内核的来源追踪与刷新。

`bridge/vendor/host-bundle.js` 是从 dsh-workbuddy-connect 的打包产物里拷出来的
（`lib/host-heartbeat-*.js`），不是稳定 API：上游一次构建就可能改变导出别名。
`bridge/kernel.json` 记录它的来源版本、大小、哈希和"语义名 → 压缩别名"的映射。

`describe()` 用于排查"桥接起不来 / 内核不匹配"；`refresh()` 用于升级内核后重新提取
并刷新记录——它会先验证桥接需要的 11 个导出仍然存在，否则拒绝写入。
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO = Path(__file__).resolve().parent.parent
BRIDGE = REPO / "bridge"
KERNEL_FILE = BRIDGE / "vendor" / "host-bundle.js"
KERNEL_META = BRIDGE / "kernel.json"
PLUGIN_PACKAGE = "dsh-workbuddy-connect"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_meta() -> Dict[str, Any]:
    try:
        return json.loads(KERNEL_META.read_text(encoding="utf-8"))
    except Exception:
        return {}


def describe() -> Dict[str, Any]:
    """当前内核 vs 记录的差异。"""
    meta = read_meta()
    if not KERNEL_FILE.is_file():
        return {"ok": False, "error": f"缺少内核文件 {KERNEL_FILE}"}
    actual = sha256(KERNEL_FILE)
    expected = str(meta.get("sha256", ""))
    return {
        "ok": actual == expected,
        "version": meta.get("version", ""),
        "source": meta.get("source", ""),
        "exports": len(meta.get("exports") or {}),
        "file": str(KERNEL_FILE),
        "size": KERNEL_FILE.stat().st_size,
        "sha256": actual,
        "recordedSha256": expected,
        "matchesRecord": actual == expected,
    }


def _installed_plugins() -> List[Path]:
    roots = [Path.home() / ".dsh" / "profiles"]
    plugins: List[Path] = []
    for root in roots:
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            candidate = child / "node_modules" / PLUGIN_PACKAGE
            if candidate.is_dir():
                plugins.append(candidate)
    return plugins


def find_source() -> Optional[Path]:
    """找到已安装插件里的内核产物（host-heartbeat-*.js）。"""
    for plugin in _installed_plugins():
        kernels = sorted((plugin / "lib").glob("host-heartbeat-*.js"))
        if kernels:
            return kernels[0]
    return None


def _package_version(plugin: Path) -> str:
    try:
        return str(json.loads((plugin / "package.json").read_text(encoding="utf-8")).get("version", ""))
    except Exception:
        return ""


def _export_names(path: Path) -> List[str]:
    """用 node 真正 import 一次，拿到运行时导出名（静态分析不可靠）。"""
    node = shutil.which("node")
    if not node:
        raise RuntimeError("找不到 node，无法验证内核导出")
    script = f"import({json.dumps(path.as_uri())}).then((ns) => console.log(JSON.stringify(Object.keys(ns))))"
    result = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"导入内核失败：{(result.stderr or '').strip()[:400]}")
    return json.loads((result.stdout or "[]").strip() or "[]")


def refresh() -> Dict[str, Any]:
    """从已安装插件重新提取内核，刷新 kernel.json。失败时回滚。"""
    meta = read_meta()
    required = (meta.get("exports") or {}).values()
    source = find_source()
    if source is None:
        return {"ok": False, "error": f"没有找到已安装的 {PLUGIN_PACKAGE}（先用 `wbconnect install --harness dsh`？）"}

    try:
        if "wb-compat" in source.read_text(encoding="utf-8", errors="replace"):
            return {
                "ok": False,
                "error": "源内核带旧补丁（wb-compat 标记），拒绝用它刷新记录；先运行 `wbconnect dsh restore`",
                "source": str(source),
            }
    except OSError as exc:
        return {"ok": False, "error": f"读取源内核失败：{exc}"}

    with tempfile.TemporaryDirectory() as tmp:
        candidate = Path(tmp) / "host-bundle.js"
        shutil.copy2(source, candidate)
        try:
            names = set(_export_names(candidate))
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}
        missing = [alias for alias in required if alias not in names]
        if missing:
            return {
                "ok": False,
                "error": "新内核缺少桥接需要的导出，已放弃刷新（需要人工重映射）",
                "missing": missing,
                "available": sorted(names),
                "source": str(source),
            }

        backup = KERNEL_FILE.with_suffix(".js.bak")
        if KERNEL_FILE.is_file():
            shutil.copy2(KERNEL_FILE, backup)
        shutil.copy2(candidate, KERNEL_FILE)

    plugin = source.parent.parent
    updated = dict(meta)
    updated.update({
        "version": _package_version(plugin) or meta.get("version", ""),
        "sha256": sha256(KERNEL_FILE),
        "size": KERNEL_FILE.stat().st_size,
        "exportedAt": f"lib/{source.name}",
    })
    KERNEL_META.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "ok": True,
        "version": updated["version"],
        "sha256": updated["sha256"],
        "size": updated["size"],
        "source": str(source),
        "backup": str(KERNEL_FILE.with_suffix(".js.bak")),
    }
