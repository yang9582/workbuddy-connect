"""端到端自检：桥接 → 凭据 → 各 harness 配置 → DSH bundle。

`wbconnect doctor`（不带参数）仍然只跑桥接内部的 `doctor.mjs`（会真的访问上游）；
`wbconnect doctor --all` 用这里的实现，只读本地状态，回答"整条链路每一环是否就绪"：

- 桥接：是否监听、healthz、登录态、本地令牌、内核版本与策略；
- 模型探测缓存：可用 / 无权限 / 未验证各多少；
- Hermes：每个 profile 的 `config.yaml` 里 provider 是否存在、端口是否对、`.env` 令牌是否在；
- 其它 harness：Claude Code / Codex / OpenClaw / DSH 的配置状态（DSH 额外看 bundle）；
- 环境：node 路径、Hermes 桌面插件是否安装。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import service
from .harnesses import REGISTRY

STATUS_MARK = {"ok": "✓", "warn": "!", "fail": "✗"}


def _check(label: str, status: str, detail: str = "", hint: str = "") -> Dict[str, Any]:
    return {"label": label, "status": status, "detail": detail, "hint": hint}


def _section(title: str, checks: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"title": title, "checks": checks}


def _yaml_load(path: Path) -> Optional[Dict[str, Any]]:
    try:
        import yaml
    except Exception:  # noqa: BLE001
        return None
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) else None


# ─────────────────────────── 各段检查 ───────────────────────────

def _bridge_checks(manager: service.BridgeManager) -> List[Dict[str, Any]]:
    checks: List[Dict[str, Any]] = []
    for inst in manager.instances():
        if not manager.setting_bool(inst.enable_key):
            checks.append(_check(f"{inst.label}", "ok", "已禁用"))
            continue
        port = manager.port(inst)
        if not manager.is_port_open(port):
            checks.append(_check(f"{inst.label} 桥接", "fail", f":{port} 未监听", "wbconnect start"))
            continue
        health = manager.health(inst)
        if not health.get("ok"):
            reason = str(health.get("error") or "healthz 不正常")
            sign = (health.get("signIn") or {}).get("state")
            checks.append(_check(
                f"{inst.label} 桥接", "warn", f":{port} 在跑，但 {reason}" + (f"（登录态 {sign}）" if sign else ""),
                "wbconnect logs；未登录时先打开 WorkBuddy 桌面 App 登录",
            ))
        else:
            sign = (health.get("signIn") or {}).get("state", "?")
            checks.append(_check(
                f"{inst.label} 桥接", "ok",
                f":{port} · 登录 {sign} · {health.get('models')} 个模型 · 目录 {health.get('catalogSource')}",
            ))
        token = manager.token(inst)
        checks.append(_check(
            f"{inst.label} 本地令牌", "ok" if token else "fail",
            "已生成" if token else "读不到（桥接可能没起过）",
            "" if token else "wbconnect start",
        ))
        kernel = health.get("kernel") or {}
        if kernel:
            matched = bool(kernel.get("matchesRecord", True))
            checks.append(_check(
                f"{inst.label} 内核", "ok" if matched else "warn",
                f"{kernel.get('version')} sha256={kernel.get('sha256')}",
                "" if matched else "wbconnect kernel --refresh",
            ))
        policy = health.get("policy") or {}
        if policy:
            checks.append(_check(
                f"{inst.label} system 策略", "ok",
                f"chat={policy.get('chat')} anthropic={policy.get('anthropic')}",
            ))
    return checks


def _probe_checks(manager: service.BridgeManager) -> List[Dict[str, Any]]:
    checks: List[Dict[str, Any]] = []
    for inst in manager.instances():
        try:
            data = json.loads(manager.probe_cache_path(inst).read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            checks.append(_check(f"{inst.label} 模型探测", "warn", "还没有探测结果", "wbconnect sync"))
            continue
        verdicts = data.get("results") or {}
        if not isinstance(verdicts, dict) or not verdicts:
            checks.append(_check(f"{inst.label} 模型探测", "warn", "缓存为空", "wbconnect sync --reprobe"))
            continue
        ok = sum(1 for value in verdicts.values() if value == "ok")
        blocked = sum(1 for value in verdicts.values() if value == "blocked")
        unknown = sum(1 for value in verdicts.values() if value not in ("ok", "blocked"))
        checks.append(_check(
            f"{inst.label} 模型探测", "warn" if unknown else "ok",
            f"可用 {ok} / 无权限 {blocked} / 未验证 {unknown}",
            "wbconnect sync --reprobe" if unknown else "",
        ))
    return checks


def _env_has(path: Path, key: str) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return False
    return any(line.strip().startswith(f"{key}=") for line in text.splitlines())


def _hermes_checks(manager: service.BridgeManager) -> List[Dict[str, Any]]:
    from .harnesses.hermes import HermesAdapter

    adapter = HermesAdapter()
    expected = {inst.key: manager.port(inst) for inst in manager.instances()}
    checks: List[Dict[str, Any]] = []
    for name, home in adapter.profile_homes("all"):
        config = home / "config.yaml"
        if not config.is_file():
            continue
        data = _yaml_load(config)
        if data is None:
            checks.append(_check(f"Hermes/{name}", "warn", "config.yaml 无法解析（缺 PyYAML 或格式异常）"))
            continue
        providers = data.get("providers") or {}
        names = sorted(providers) if isinstance(providers, dict) else []
        missing = [key for key in expected if key not in names]
        if missing:
            checks.append(_check(
                f"Hermes/{name}", "warn",
                f"缺 provider: {', '.join(missing)}（现有 {', '.join(names) or '无'}）",
                f"wbconnect sync --profiles {name}",
            ))
            continue
        wrong_port = [
            key for key, port in expected.items()
            if f"127.0.0.1:{port}" not in str((providers.get(key) or {}).get("base_url", ""))
        ]
        env_missing = [
            inst.token_env for inst in manager.instances()
            if inst.key in expected and not _env_has(home / ".env", inst.token_env)
        ]
        issues = []
        if wrong_port:
            issues.append(f"端口不匹配: {', '.join(wrong_port)}")
        if env_missing:
            issues.append(f".env 缺令牌: {', '.join(env_missing)}")
        checks.append(_check(
            f"Hermes/{name}", "warn" if issues else "ok",
            "; ".join(issues) if issues else f"provider 就绪（{len(names)} 个）",
            f"wbconnect sync --profiles {name}" if issues else "",
        ))
    return checks


def _harness_checks(manager: service.BridgeManager) -> List[Dict[str, Any]]:
    checks: List[Dict[str, Any]] = []
    for name, cls in REGISTRY.items():
        if name in ("hermes", "generic"):
            continue  # Hermes 上面单独按 profile 检查；generic 永远"检测到"，单独处理无意义
        adapter = cls()
        try:
            if not adapter.detect():
                continue
            info = adapter.status()
        except Exception as exc:  # noqa: BLE001
            checks.append(_check(f"{adapter.label or name}", "warn", f"检测失败: {exc}"))
            continue
        if name == "dsh":
            bundle = info.get("bundle") or {}
            mode = info.get("mode", "not-configured")
            if bundle.get("installed"):
                checks.append(_check("DeepSeek Harness", "ok" if mode == "bundle" else "warn",
                                     f"mode={mode} · bundle {bundle.get('package')} 已安装"))
            elif mode == "profile-patch":
                checks.append(_check("DeepSeek Harness", "ok", "mode=profile-patch（未装 bundle）"))
            else:
                checks.append(_check("DeepSeek Harness", "warn", "未接入", "wbconnect install --harness dsh"))
            legacy = info.get("legacy_patched") or []
            if legacy:
                checks.append(_check("DeepSeek Harness 旧补丁", "warn", f"{len(legacy)} 个文件仍带 wb-compat", "wbconnect dsh restore"))
            official = [row for row in info.get("profiles", []) if row.get("official_installed")]
            if official:
                checks.append(_check(
                    "DSH 官方插件", "warn",
                    f"仍安装（{official[0].get('official_version') or '?'}），建议在插件页卸载",
                    "卸载后运行 wbconnect dsh bundle 去掉关闭行，再重启 DSH",
                ))
            continue
        configured = bool(info.get("configured"))
        detail = str(info.get("base_url") or info.get("config") or info.get("settings") or "")
        checks.append(_check(
            f"{adapter.label or name}", "ok" if configured else "warn",
            ("已配置 " + detail).strip() if configured else "已检测到，未配置",
            "" if configured else f"wbconnect install --harness {name}",
        ))
    return checks


def _environment_checks(manager: service.BridgeManager) -> List[Dict[str, Any]]:
    checks: List[Dict[str, Any]] = []
    try:
        checks.append(_check("Node.js", "ok", manager.node_path()))
    except Exception as exc:  # noqa: BLE001
        checks.append(_check("Node.js", "fail", str(exc), "安装 Node 或在插件设置里指定 node_path"))
    try:
        from .harnesses.hermes import HermesAdapter

        home = HermesAdapter().hermes_home()
        plugin = home / "desktop-plugins" / "workbuddy" / "plugin.js"
        if plugin.is_file():
            checks.append(_check("Hermes 桌面插件", "ok", str(plugin)))
        else:
            checks.append(_check("Hermes 桌面插件", "warn", "未安装（只有后端工具）", "wbconnect install --harness hermes"))
    except Exception as exc:  # noqa: BLE001
        checks.append(_check("Hermes 桌面插件", "warn", f"无法检查: {exc}"))
    return checks


def _deploy_checks() -> List[Dict[str, Any]]:
    """profile 里的插件副本是否与仓库同版本（部署漂移）。"""
    from . import __version__
    from .harnesses.hermes import HermesAdapter, VERSION_MARKER

    checks: List[Dict[str, Any]] = []
    for name, home in HermesAdapter().profile_homes("all"):
        plugin = home / "plugins" / "workbuddy"
        if not (plugin / "plugin.yaml").is_file():
            checks.append(_check(f"部署/{name}", "warn", "未安装", "wbconnect install --harness hermes --profiles all"))
            continue
        marker = plugin / VERSION_MARKER
        installed = ""
        if marker.is_file():
            try:
                installed = marker.read_text(encoding="utf-8").strip()
            except Exception:
                installed = ""
        if installed == __version__:
            checks.append(_check(f"部署/{name}", "ok", f"插件 {installed}"))
        else:
            checks.append(_check(
                f"部署/{name}", "warn",
                f"副本 {installed or '未知版本'}，仓库 {__version__}",
                "wbconnect install --harness hermes --profiles all",
            ))
    return checks


# ─────────────────────────── 汇总 / 渲染 ───────────────────────────

def collect(manager: service.BridgeManager) -> Dict[str, Any]:
    sections = [
        _section("桥接", _bridge_checks(manager)),
        _section("模型探测", _probe_checks(manager)),
        _section("Hermes provider", _hermes_checks(manager)),
        _section("其它 harness", _harness_checks(manager)),
        _section("插件部署", _deploy_checks()),
        _section("环境", _environment_checks(manager)),
    ]
    checks = [item for section in sections for item in section["checks"]]
    counts = {key: sum(1 for item in checks if item["status"] == key) for key in ("ok", "warn", "fail")}
    return {"ok": counts["fail"] == 0, "counts": counts, "sections": sections}


def render(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    for section in report["sections"]:
        lines.append(f"■ {section['title']}")
        for item in section["checks"]:
            detail = f"  {item['detail']}" if item.get("detail") else ""
            lines.append(f"  {STATUS_MARK[item['status']]} {item['label']}{detail}")
            if item["status"] != "ok" and item.get("hint"):
                lines.append(f"      → {item['hint']}")
    counts = report["counts"]
    lines.append("")
    lines.append(f"结果：{counts['ok']} 正常 / {counts['warn']} 警告 / {counts['fail']} 失败")
    return "\n".join(lines)
