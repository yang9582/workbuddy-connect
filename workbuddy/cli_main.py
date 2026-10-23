"""wbconnect —— 跨 harness 的 WorkBuddy 连接器命令行。

用法：
    python -m workbuddy.cli_main status
    python -m workbuddy.cli_main install --harness all
    python -m workbuddy.cli_main endpoint --show-token
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List

from . import providers_sync, service
from . import cli as hermes_cli
from .harnesses import REGISTRY, detect_all, get


def _manager() -> service.BridgeManager:
    return service.BridgeManager(None)


def _harness_list(value: str) -> List[str]:
    value = (value or "").strip()
    if not value or value.lower() == "all":
        return [name for name, cls in REGISTRY.items() if cls().detect()]
    names = [part.strip() for part in value.split(",") if part.strip()]
    unknown = [name for name in names if name not in REGISTRY]
    if unknown:
        raise SystemExit(f"未知 harness: {', '.join(unknown)}（可用: {', '.join(REGISTRY)}）")
    return names


def _cmd_status(manager) -> int:
    print(hermes_cli.render_status(manager))
    print()
    for adapter in detect_all():
        info = adapter.status()
        mark = "已配置" if info.get("configured") else "检测到（未配置）"
        print(f"[{adapter.label}] {mark}")
    return 0


def _cmd_models(manager, args) -> int:
    for inst in manager.instances():
        if args.instance and args.instance != inst.key:
            continue
        try:
            manager.ensure(inst)
            rows = manager.models(inst)
        except Exception as exc:  # noqa: BLE001
            print(f"[{inst.key}] 失败: {exc}")
            continue
        print(f"[{inst.key}] {len(rows)} 个模型")
        for row in rows:
            print(f"  {row.get('id')}")
    return 0


def _cmd_endpoint(manager, args) -> int:
    from .harnesses.base import HarnessAdapter

    adapter = HarnessAdapter()
    endpoint = adapter.endpoint(manager, args.instance)
    token = endpoint["token"]
    shown = token if args.show_token else (token[:6] + "…" + token[-4:] if len(token) > 12 else "***")
    print(json.dumps({
        "base_url": endpoint["base_url"],
        "api_key": shown,
        "default_model": endpoint["model"],
        "models": endpoint["models"],
    }, ensure_ascii=False, indent=2))
    if not args.show_token:
        print("\n（令牌已打码；--show-token 显示完整值）")
    return 0


def _cmd_harnesses() -> int:
    for name, cls in REGISTRY.items():
        adapter = cls()
        detected = adapter.detect()
        info = adapter.status() if detected else {}
        extra = f"  {info.get('version') or ''}".rstrip()
        print(f"{name:10s} {adapter.label:24s} {'检测到' if detected else '未检测到'}{extra}")
    return 0


def _cmd_install(manager, args) -> int:
    names = _harness_list(args.harness)
    if not names:
        print("没有检测到任何 harness；可用 --harness hermes,claude,codex,openclaw,dsh,generic")
        return 1
    for name in names:
        adapter = get(name)()
        print(f"=== {adapter.label} ===")
        try:
            for line in adapter.install(manager, profiles=args.profiles, dry_run=args.dry_run):
                print("  " + line)
        except Exception as exc:  # noqa: BLE001
            print(f"  失败: {exc}")
    return 0


def _cmd_uninstall(manager, args) -> int:
    for name in _harness_list(args.harness):
        adapter = get(name)()
        print(f"=== {adapter.label} ===")
        try:
            for line in adapter.uninstall(manager):
                print("  " + line)
        except Exception as exc:  # noqa: BLE001
            print(f"  失败: {exc}")
    return 0


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wbconnect", description="WorkBuddy → 多 harness 连接器")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("status", help="桥接与各 harness 状态")
    sub.add_parser("start", help="启动桥接实例")
    sub.add_parser("stop", help="停止桥接实例")
    sub.add_parser("restart", help="重启桥接实例")
    sub.add_parser("doctor", help="运行桥接自检")

    models = sub.add_parser("models", help="列出模型")
    models.add_argument("--instance", default="", help="workbuddy | workbuddy-ai")

    endpoint = sub.add_parser("endpoint", help="打印 OpenAI 兼容端点（给没有插件体系的 harness 用）")
    endpoint.add_argument("--instance", default="workbuddy-ai")
    endpoint.add_argument("--show-token", action="store_true")

    sub.add_parser("harnesses", help="列出支持的 harness 与检测结果")

    install = sub.add_parser("install", help="安装/配置到 harness")
    install.add_argument("--harness", default="all", help="all 或 hermes,claude,codex,openclaw,dsh,generic")
    install.add_argument("--profiles", default="", help="Hermes profile：all 或逗号分隔")
    install.add_argument("--dry-run", action="store_true")

    uninstall = sub.add_parser("uninstall", help="移除 harness 配置")
    uninstall.add_argument("--harness", default="all")

    sync = sub.add_parser("sync", help="刷新 Hermes provider 配置")
    sync.add_argument("--profiles", default="")
    sync.add_argument("--reprobe", action="store_true")
    sync.add_argument("--no-probe", action="store_true")

    logs = sub.add_parser("logs", help="查看桥接日志")
    logs.add_argument("--instance", default="")
    logs.add_argument("--lines", type=int, default=40)

    args = parser.parse_args(argv)
    cmd = args.cmd or "status"
    manager = _manager()

    if cmd == "status":
        return _cmd_status(manager)
    if cmd == "start":
        for inst in manager.instances():
            result = manager.start(inst)
            print(f"[{inst.label}] 已启动 :{result.get('port')}（pid {result.get('pid', '-')}）")
        return 0
    if cmd == "stop":
        for inst in manager.instances():
            result = manager.stop(inst)
            print(f"[{inst.label}] " + ("已停止" if result.get("stopped") else "本来就没在运行"))
        return 0
    if cmd == "restart":
        for inst in manager.instances():
            manager.stop(inst)
            result = manager.start(inst)
            print(f"[{inst.label}] 已重启 :{result.get('port')}（pid {result.get('pid', '-')}）")
        return 0
    if cmd == "doctor":
        print(hermes_cli._doctor(manager))  # noqa: SLF001
        return 0
    if cmd == "models":
        return _cmd_models(manager, args)
    if cmd == "endpoint":
        return _cmd_endpoint(manager, args)
    if cmd == "harnesses":
        return _cmd_harnesses()
    if cmd == "install":
        return _cmd_install(manager, args)
    if cmd == "uninstall":
        return _cmd_uninstall(manager, args)
    if cmd == "sync":
        summary = providers_sync.sync(
            manager, explicit=(args.profiles or None),
            probe=not args.no_probe, force_probe=args.reprobe,
        )
        print(hermes_cli._render_sync(summary))  # noqa: SLF001
        return 0
    if cmd == "logs":
        for inst in manager.instances():
            if args.instance and inst.key != args.instance:
                continue
            print(f"=== {inst.key} ===")
            print(manager.logs_tail(inst, args.lines))
        return 0
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
