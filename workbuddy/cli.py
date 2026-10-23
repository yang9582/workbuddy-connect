"""``hermes workbuddy`` 子命令与 ``/workbuddy`` 斜杠命令的文本渲染。

子命令：status | start | stop | restart | sync | cleanup | logs | doctor
"""

from __future__ import annotations

import os
import subprocess
from typing import Any

from . import providers_sync, service


# ─────────────────────────── 文本渲染 ───────────────────────────

def _line(inst, status: dict) -> str:
    state = "运行中" if status.get("running") else "已停止"
    health = status.get("health") or {}
    bits = [f"[{inst.label}] {state} · :{status.get('port')}"]
    if status.get("running"):
        sign_in = health.get("signIn") or {}
        if sign_in.get("state") == "signed-in":
            bits.append("登录正常")
        elif sign_in.get("state"):
            bits.append(f"登录态: {sign_in.get('state')}")
        if isinstance(health.get("models"), int):
            bits.append(f"{health['models']} 个模型")
        probe = status.get("model_probe")
        if isinstance(probe, dict) and (probe.get("blocked") or probe.get("ok")):
            total = (probe.get("ok") or 0) + (probe.get("blocked") or 0) + (probe.get("unknown") or 0)
            bits.append(f"账号可用 {probe.get('ok', 0)}/{total}")
        if health.get("catalogSource"):
            bits.append(f"目录: {health['catalogSource']}")
    if status.get("last_error"):
        bits.append(f"上次错误: {status['last_error']}")
    return " · ".join(bits)


def render_status(manager) -> str:
    try:
        have = set(providers_sync.registered_providers())
    except Exception:
        have = set()
    lines = []
    for inst in manager.instances():
        lines.append(_line(inst, manager.status(inst)))
        mark = "✓" if inst.key in have else "✗（未注册）"
        lines.append(f"  provider {inst.key}: {mark}")
    if not manager.instances():
        lines.append("没有启用的实例（检查 enable_cn / enable_ai 设置）")
    lines.append(f"数据目录: {manager.data_dir()}")
    return "\n".join(lines)


def render_slash(manager, raw_args: str) -> str:
    parts = (raw_args or "").strip().split()
    cmd = parts[0].lower() if parts else "status"
    if cmd in {"help", "-h", "--help"}:
        return "用法: /workbuddy [status|start|stop|sync|logs]"
    if cmd == "status":
        return render_status(manager)
    if cmd == "start":
        out = []
        for inst in manager.instances():
            try:
                result = manager.start(inst)
                out.append(f"[{inst.label}] 已启动 :{result.get('port')}（pid {result.get('pid', '-')}）")
            except Exception as exc:  # noqa: BLE001
                out.append(f"[{inst.label}] 启动失败: {exc}")
        return "\n".join(out)
    if cmd == "stop":
        out = []
        for inst in manager.instances():
            result = manager.stop(inst)
            out.append(f"[{inst.label}] " + ("已停止" if result.get("stopped") else "本来就没在运行"))
        return "\n".join(out)
    if cmd == "sync":
        summary = providers_sync.sync(manager)
        return _render_sync(summary)
    if cmd == "logs":
        inst = manager.instances()[0] if manager.instances() else service.INSTANCES[0]
        return manager.logs_tail(inst, 20)
    return f"未知子命令: {cmd}\n用法: /workbuddy [status|start|stop|sync|logs]"


def _render_sync(summary: dict) -> str:
    lines = []
    for label, entry in (summary.get("profiles") or {}).items():
        for key, info in entry.items():
            if isinstance(info, dict) and "error" in info:
                lines.append(f"[{label}] {key}: ✗ {info['error']}")
            else:
                total = info.get("models_total")
                blocked = info.get("models_blocked") or []
                counts = f"{info.get('models')} 个模型" + (f"（共 {total}，跳过 {len(blocked)} 个无权限）" if total and len(blocked) else "")
                lines.append(f"[{label}] {key}: ✓ {counts}，默认 {info.get('model_default')}")
    for error in summary.get("errors") or []:
        lines.append(f"错误: {error}")
    return "\n".join(lines) or "没有需要同步的 profile"


# ─────────────────────────── 命令实现 ───────────────────────────

def _doctor(manager) -> str:
    node = manager.node_path()
    out = []
    for inst in manager.instances():
        env = dict(os.environ)
        env["WORKBUDDY_BRIDGE_CONFIG"] = str(manager.config_path(inst))
        env["WORKBUDDY_BRIDGE_STATE"] = str(manager.state_dir())
        electron = manager.setting_str(inst.electron_key)
        if electron:
            env[inst.electron_env] = electron
        try:
            result = subprocess.run(
                [node, str(service.BRIDGE_DIR / "doctor.mjs"), inst.variant],
                cwd=str(service.BRIDGE_DIR), env=env, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=120,
            )
            out.append(f"=== {inst.key} ===\n{(result.stdout or '').strip()}")
            if result.returncode != 0:
                out.append((result.stderr or '').strip()[:800])
        except Exception as exc:  # noqa: BLE001
            out.append(f"=== {inst.key} ===\n自检失败: {exc}")
    return "\n".join(out)


def build(manager):
    """返回 (setup_fn, handler_fn) 供 ctx.register_cli_command 使用。"""

    def setup(subparser) -> None:
        subs = subparser.add_subparsers(dest="workbuddy_cmd")
        subs.add_parser("status", help="桥接状态（只读，不启动）")
        subs.add_parser("start", help="启动桥接实例")
        subs.add_parser("stop", help="停止桥接实例")
        subs.add_parser("restart", help="重启桥接实例")
        sync_parser = subs.add_parser("sync", help="刷新 provider 配置（默认按插件设置）")
        sync_parser.add_argument("--profiles", default="", help="all / current / 逗号分隔的 profile 名")
        sync_parser.add_argument("--reprobe", action="store_true", help="忽略缓存，重新探测模型权限")
        sync_parser.add_argument("--no-probe", action="store_true", help="跳过权限探测（写入目录里的全部模型）")
        cleanup_parser = subs.add_parser("cleanup", help="移除 provider 配置与 .env 令牌")
        cleanup_parser.add_argument("--profiles", default="current", help="current（默认）/ all / 逗号分隔")
        logs_parser = subs.add_parser("logs", help="查看桥接日志")
        logs_parser.add_argument("--lines", type=int, default=40)
        logs_parser.add_argument("--instance", default="", help="workbuddy | workbuddy-ai")
        doctor_parser = subs.add_parser("doctor", help="运行桥接自检（登录态/模型目录/积分）")
        doctor_parser.add_argument("--instance", default="", help="workbuddy | workbuddy-ai（默认全部）")
        install_parser = subs.add_parser("install", help="把本插件复制并启用到其他 profile（机器人）")
        install_parser.add_argument("--profiles", default="all", help="all（默认）/ 逗号分隔的 profile 名")
        subparser.set_defaults(func=handle)

    def handle(args) -> None:
        cmd = getattr(args, "workbuddy_cmd", None) or "status"
        try:
            if cmd == "status":
                print(render_status(manager))
            elif cmd == "start":
                for inst in manager.instances():
                    try:
                        result = manager.start(inst)
                        print(f"[{inst.label}] 已启动 :{result.get('port')}（pid {result.get('pid', '-')}）")
                    except Exception as exc:  # noqa: BLE001
                        print(f"[{inst.label}] 启动失败: {exc}")
            elif cmd == "stop":
                for inst in manager.instances():
                    result = manager.stop(inst)
                    print(f"[{inst.label}] " + ("已停止" if result.get("stopped") else "本来就没在运行"))
            elif cmd == "restart":
                for inst in manager.instances():
                    manager.stop(inst)
                    try:
                        result = manager.start(inst)
                        print(f"[{inst.label}] 已重启 :{result.get('port')}（pid {result.get('pid', '-')}）")
                    except Exception as exc:  # noqa: BLE001
                        print(f"[{inst.label}] 重启失败: {exc}")
            elif cmd == "sync":
                print(_render_sync(providers_sync.sync(
                    manager,
                    explicit=(args.profiles or None),
                    probe=not getattr(args, "no_probe", False),
                    force_probe=getattr(args, "reprobe", False),
                )))
            elif cmd == "cleanup":
                print(_render_cleanup(providers_sync.cleanup(manager, spec=args.profiles or "current")))
            elif cmd == "logs":
                insts = [i for i in manager.instances() if not args.instance or i.key == args.instance]
                for inst in insts or list(manager.instances()):
                    print(f"=== {inst.key} ({manager.log_path(inst)}) ===")
                    print(manager.logs_tail(inst, args.lines))
            elif cmd == "doctor":
                print(_doctor(manager))
            elif cmd == "install":
                print(_install(manager, args.profiles or "all"))
            else:
                print("用法: hermes workbuddy [status|start|stop|restart|sync|cleanup|logs|doctor]")
        except Exception as exc:  # noqa: BLE001
            print(f"[workbuddy] 命令失败: {exc}")

    return setup, handle


def _install(manager, spec: str) -> str:
    """把插件目录复制到目标 profile 的 plugins/ 并启用（profile 之间的插件是独立副本）。"""
    import shutil

    from .providers_sync import _run, current_profile, profiles_root, resolve_targets

    source = service.PLUGIN_DIR
    current = current_profile()
    lines = ["（其他 profile 拿到的是独立副本；升级后重跑本命令即可覆盖）"]
    for profile in resolve_targets(spec):
        if profile is None:
            lines.append(f"[{current or 'default'}] 跳过：当前 profile 已安装")
            continue
        dest = profiles_root() / profile / "plugins" / "workbuddy"
        try:
            if dest.exists():
                shutil.rmtree(dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        except Exception as exc:  # noqa: BLE001
            lines.append(f"[{profile}] 复制失败: {exc}")
            continue
        result = _run(["plugins", "enable", "workbuddy"], profile, timeout=900)
        if result.returncode == 0:
            lines.append(f"[{profile}] 已复制并启用")
        else:
            detail = (result.stderr or result.stdout or "").strip().splitlines()
            lines.append(
                f"[{profile}] 已复制，但自动启用失败，请手动运行：hermes -p {profile} plugins enable workbuddy"
                + (f"（{detail[-1]}）" if detail else "")
            )
    return "\n".join(lines)


def _render_cleanup(result: dict) -> str:
    lines = []
    for label, keys in (result.get("removed") or {}).items():
        if keys:
            lines.append(f"[{label}] 已移除: {', '.join(keys)}")
        else:
            lines.append(f"[{label}] 没有可移除的配置")
    return "\n".join(lines)
