"""provider 注册：把桥接实例写成 Hermes 的 ``providers.<名字>`` 并同步 ``.env`` 令牌。

- provider 名：``workbuddy`` / ``workbuddy-ai``（与旧方案完全一致）
- ``base_url``：``http://127.0.0.1:<port>/v1``，``api_mode: chat_completions``
- ``api_key``：``${WORKBUDDY_BRIDGE_TOKEN}`` / ``${WORKBUDDY_AI_BRIDGE_TOKEN}`` 占位符，
  真实令牌写进目标 profile 的 ``.env``（与旧方案一致，config.yaml 不落明文）
- ``models``：桥接 ``/v1/models`` 的实时目录（id → name/context_length）
- 写配置统一走 ``hermes [ -p <profile> ] config set``（不手改 config.yaml）
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

# 默认选中模型的优先顺序（只在该账号可用的模型里挑）
PROVIDER_DEFAULT_MODEL = {
    "workbuddy": ("glm-5.3-flash", "deepseek-v4.1-flash", "hy3"),
    "workbuddy-ai": ("deepseek-v4.1-flash", "fast-model", "glm-5.3-flash", "gpt-5.6-terra"),
}
STATE_KEY = "catalog_fingerprint"


# ─────────────────────────── Hermes CLI 调用 ───────────────────────────

def hermes_exe() -> str:
    candidate = Path(sys.executable).with_name("hermes.exe" if os.name == "nt" else "hermes")
    if candidate.is_file():
        return str(candidate)
    found = shutil.which("hermes")
    if not found:
        raise RuntimeError("找不到 hermes 可执行文件（插件需要它来写 provider 配置）")
    return found


def _kill_tree(pid: int) -> None:
    """结束整棵进程树。

    `subprocess.run(timeout=...)` 只杀直接子进程；Hermes CLI 会再拉起
    `pm-runtime` 之类的孙进程，它们继承 stdout 句柄，会让调用方永远等不到 EOF
    （表现为 `wbconnect sync --profiles all` 写完了却不返回）。
    """
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=20)
        else:
            import signal

            os.killpg(os.getpgid(pid), signal.SIGKILL)
    except Exception:
        pass


def _run(args: List[str], profile: Optional[str] = None, timeout: float = 180.0) -> subprocess.CompletedProcess:
    """跑一次 hermes CLI。

    输出写临时文件而不是 PIPE：hermes 会拉起常驻的 pm-runtime 子进程，它们继承
    stdout 管道后，调用方会一直等不到 EOF（表现是 `wbconnect install` 干完了却不返回）。
    这里用 `proc.wait(timeout)` 只等直接子进程，再回读文件，从根上避免该问题。
    """
    cmd = [hermes_exe()]
    if profile:
        cmd += ["-p", profile]
    cmd += args
    # 指定 profile 时清掉 HERMES_HOME，避免与 -p 冲突；当前 profile 则保留原环境
    env = {k: v for k, v in os.environ.items() if k != "HERMES_HOME"} if profile else dict(os.environ)
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

    with tempfile.TemporaryFile() as sink:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=sink,
            stderr=subprocess.STDOUT,
            env=env,
            creationflags=flags,
            start_new_session=(os.name != "nt"),
        )
        try:
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc.pid)
            try:
                code = proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                code = -1
            raise RuntimeError(f"hermes {' '.join(args)} 超时（{int(timeout)}s）") from None
        sink.seek(0)
        output = sink.read().decode("utf-8", "replace")
    return subprocess.CompletedProcess(cmd, code, output, "")


def _get(key: str, profile: Optional[str]) -> str:
    result = _run(["config", "get", key], profile, timeout=60)
    return (result.stdout or "").strip() if result.returncode == 0 else ""


def _set(key: str, value: str, profile: Optional[str]) -> None:
    result = _run(["config", "set", key, value], profile)
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"hermes config set {key} 失败: {message[:300]}")


def _unset(key: str, profile: Optional[str]) -> bool:
    result = _run(["config", "unset", key], profile, timeout=60)
    return result.returncode == 0


def run_hermes(args: List[str], profile: Optional[str] = None, timeout: float = 180.0) -> subprocess.CompletedProcess:
    """供其它模块调用的 hermes CLI 包装：带超时，超时会结束整棵进程树。"""
    return _run(args, profile, timeout)


# ─────────────────────────── profile 解析 ───────────────────────────

def current_profile() -> Optional[str]:
    """当前进程所属 profile 名（默认 profile 返回 None）。"""
    try:
        from hermes_constants import get_hermes_home
        home = get_hermes_home()
    except Exception:
        return None
    return home.name if home.parent.name == "profiles" else None


def current_home() -> Path:
    """当前 Hermes home（Hermes 进程内优先用官方常量，CLI 里回落到 $HERMES_HOME）。"""
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home()
    except Exception:
        env = os.environ.get("HERMES_HOME", "").strip()
        if env:
            return Path(env)
        if os.name == "nt":
            root = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
            return Path(root) / "hermes"
        return Path.home() / ".hermes"


def profiles_root() -> Path:
    """Hermes 的 profiles 根目录。

    从 wbconnect CLI（Hermes 进程之外）运行时 import 不到 `hermes_constants`，
    必须回落到 `$HERMES_HOME`（与 harnesses/hermes.py 保持一致），否则会把
    `~/.hermes` 当成 home，导致 `--profiles all` 只同步默认 profile。
    """
    home = current_home()
    root = home.parent.parent if home.parent.name == "profiles" else home
    return root / "profiles"


def list_profiles() -> List[str]:
    root = profiles_root()
    if not root.is_dir():
        return []
    return sorted(
        child.name for child in root.iterdir()
        if child.is_dir() and (child / "config.yaml").is_file()
    )


def resolve_targets(spec: str) -> List[Optional[str]]:
    """把 ``all`` / ``current`` / 逗号列表解析成 profile 目标（None = 当前 profile）。"""
    spec = (spec or "").strip()
    current = current_profile()
    if not spec or spec.lower() in {"current", "self"}:
        return [None]
    if spec.lower() == "all":
        return [None] + [name for name in list_profiles() if name != current]
    targets: List[Optional[str]] = []
    for raw in spec.split(","):
        name = raw.strip()
        if not name:
            continue
        if name.lower() in {"current", "self"}:
            targets.append(None)
        elif name == current:
            targets.append(None)
        else:
            targets.append(name)
    return targets or [None]


# ─────────────────────────── provider 构建 ───────────────────────────

def _models_payload(models: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    payload: Dict[str, Dict[str, Any]] = {}
    for row in models:
        model_id = row["id"]
        entry: Dict[str, Any] = {}
        name = row.get("name")
        if isinstance(name, str) and name:
            entry["name"] = name
        context = row.get("context_length")
        if isinstance(context, int) and context > 0:
            entry["context_length"] = context
        payload[model_id] = entry
    return payload


def sync_instance(
    inst, manager, profile: Optional[str], *, probe: bool = True, force_probe: bool = False,
) -> Dict[str, Any]:
    """把一个实例写成目标 profile 的 provider（含 .env 令牌）。"""
    models = manager.models(inst)
    if not models:
        raise RuntimeError(f"{inst.key}: 桥接没有返回任何模型（WorkBuddy 桌面 App 是否已登录？）")

    # 账号权限探测：上游 400/11158（not allowed for user type）的模型不写进 provider
    verdicts = manager.probe_models(inst, models, force=force_probe) if probe else {}
    allowed = [row for row in models if verdicts.get(row["id"], "ok") != "blocked"]
    blocked = [row["id"] for row in models if verdicts.get(row["id"]) == "blocked"]
    # 探测失败（超时/429/非 11158 的 4xx）记为 unknown：仍然写入，但要在摘要里明确告知，
    # 否则用户会以为"全部可用"，选中后才拿到 400。
    unverified = [row["id"] for row in allowed if probe and verdicts.get(row["id"]) == "unknown"]
    if not allowed:
        raise RuntimeError(f"{inst.key}: 当前账号没有任何可用模型（{len(models)} 个全部被上游拒绝）")

    ids = {row["id"] for row in allowed}
    existing = _get(f"providers.{inst.key}.model", profile)
    fallback = next((name for name in PROVIDER_DEFAULT_MODEL.get(inst.key, ()) if name in ids), "")
    if existing in ids:
        model = existing
    elif fallback:
        model = fallback
    else:
        model = allowed[0]["id"]

    token = manager.token(inst)
    if not token:
        raise RuntimeError(f"{inst.key}: 读不到桥接令牌（实例是否正常启动？）")

    payload = {
        "base_url": f"http://127.0.0.1:{manager.port(inst)}/v1",
        "api_key": "${" + inst.token_env + "}",
        "api_mode": "chat_completions",
        "model": model,
        "models": _models_payload(allowed),
    }
    _set(inst.token_env, token, profile)  # 写进该 profile 的 .env（不打印值）
    provider_key = f"providers.{inst.key}"
    try:
        _set(provider_key, json.dumps(payload, ensure_ascii=True), profile)
        verified = _get(f"{provider_key}.base_url", profile)
        if verified and verified != payload["base_url"]:
            raise RuntimeError(f"{inst.key}: 写入后校验失败（base_url={verified}）")
    except Exception:
        # 事务回滚：无法可靠还原任意旧值，直接移除半写入的 provider，
        # 让目标 profile 回到"没有这个 provider"的干净状态，而不是留一份坏配置。
        _unset(provider_key, profile)
        raise
    return {
        "provider": inst.key,
        "instance": inst.key,
        "models": len(allowed),
        "models_total": len(models),
        "models_blocked": blocked,
        "models_unverified": unverified,
        "model_default": model,
        "base_url": payload["base_url"],
        "token_env": inst.token_env,
        "verified": True,
    }


def sync(
    manager,
    explicit: Optional[str] = None,
    *,
    probe: Optional[bool] = None,
    force_probe: bool = False,
) -> Dict[str, Any]:
    """同步到目标 profile；返回按 profile 分组的摘要（不含任何令牌）。

    ``probe=None`` 时按插件设置 ``probe_models`` 决定是否做账号权限探测。
    """
    if probe is None:
        probe = manager.setting_bool("probe_models")
    spec = (explicit if explicit is not None and explicit != "" else manager.setting_str("sync_profiles"))
    targets = resolve_targets(spec)
    summary: Dict[str, Any] = {"profiles": {}, "errors": []}
    for profile in targets:
        label = profile or (current_profile() or "default")
        entry: Dict[str, Any] = {}
        for inst in manager.instances():
            try:
                manager.ensure(inst)
                entry[inst.key] = sync_instance(
                    inst, manager, profile, probe=probe, force_probe=force_probe
                )
            except Exception as exc:
                entry[inst.key] = {"error": str(exc)}
                summary["errors"].append(f"{label}/{inst.key}: {exc}")
        summary["profiles"][label] = entry
    return summary


def cleanup(manager, spec: str = "current") -> Dict[str, Any]:
    """从目标 profile 移除 provider 配置与 .env 令牌（插件卸载前的清理）。"""
    targets = resolve_targets(spec)
    removed: Dict[str, List[str]] = {}
    for profile in targets:
        label = profile or (current_profile() or "default")
        keys: List[str] = []
        for inst in manager.instances():
            for key in (f"providers.{inst.key}", inst.token_env):
                if _unset(key, profile):
                    keys.append(key)
        removed[label] = keys
    return {"removed": removed}


# ─────────────────────────── 自动同步 ───────────────────────────

def fingerprint(manager) -> Dict[str, str]:
    prints: Dict[str, str] = {}
    for inst in manager.instances():
        try:
            models = manager.models(inst)
        except Exception:
            continue
        blob = "|".join(
            f"{row.get('id')}:{row.get('name')}:{row.get('context_length')}" for row in sorted(models, key=lambda r: r.get("id", ""))
        )
        prints[inst.key] = hashlib.sha1(blob.encode("utf-8")).hexdigest()
    return prints


def registered_providers() -> List[str]:
    """当前 profile 已注册的 provider 名。

    Hermes 进程内直接读运行时配置；`wbconnect` CLI 里 import 不到
    `hermes_cli.config`，以前会静默返回空列表 —— 于是 `wbconnect status`
    把明明存在的 provider 显示成"未注册"。这里补一条直接读 config.yaml 的兜底。
    """
    try:
        from hermes_cli.config import load_config_readonly

        config = load_config_readonly() or {}
        providers = config.get("providers")
        if isinstance(providers, dict) and providers:
            return sorted(providers)
    except Exception:
        pass

    path = current_home() / "config.yaml"
    try:
        import yaml

        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return []
    providers = data.get("providers") if isinstance(data, dict) else None
    return sorted(providers) if isinstance(providers, dict) else []


def auto_sync(manager) -> Optional[Dict[str, Any]]:
    """模型目录或 provider 存在性变化时才重新同步（会话启动钩子调用）。"""
    current = fingerprint(manager)
    if not current:
        return None
    state = getattr(manager.ctx, "state", None) if manager.ctx is not None else None
    previous: Dict[str, str] = {}
    if state is not None:
        try:
            previous = state.get(STATE_KEY, default={}) or {}
        except Exception:
            previous = {}
    have = set(registered_providers())
    missing = [inst.key for inst in manager.instances() if inst.key not in have]
    if not missing and previous == current:
        return None
    summary = sync(manager)
    if state is not None and not summary.get("errors"):
        try:
            state.set(STATE_KEY, current)
        except Exception:
            pass
    return summary
