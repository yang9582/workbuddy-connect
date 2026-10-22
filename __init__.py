"""WorkBuddy 插件入口 —— 把 WorkBuddy / WorkBuddy AI 桌面 App 的模型接入 Hermes Agent。

组成
----
- ``bridge/``  Node 桥接（与 WorkBuddy 桌面 App 登录态同源，暴露 OpenAI 兼容接口）；
- ``service.py``      进程与数据管理（懒启动、健康检查、机器级数据目录、旧目录迁移）；
- ``providers_sync.py``  把实例注册成 Hermes 自定义 provider（含 .env 令牌）；
- ``tools.py`` / ``schemas.py``  三个工具：status / models / sync；
- ``cli.py``          ``hermes workbuddy ...`` 与 ``/workbuddy``。

注册期不产生任何副作用（不联网、不起进程），副作用只发生在工具调用、
CLI 命令与 ``on_session_start`` 钩子里 —— 这也是 ``hermes plugins doctor`` 能安全校验的原因。
"""

from __future__ import annotations

import logging
import threading

from . import cli as wb_cli
from . import schemas, service, tools

logger = logging.getLogger(__name__)


def register(ctx) -> None:
    manager = service.BridgeManager(ctx)
    handlers = tools.build_handlers(ctx, manager)

    ctx.register_tool(
        name="workbuddy_status",
        toolset="workbuddy",
        schema=schemas.STATUS,
        handler=handlers["workbuddy_status"],
        description="WorkBuddy 桥接状态（登录态 / 模型数 / 积分 / provider 是否已注册）",
    )
    ctx.register_tool(
        name="workbuddy_models",
        toolset="workbuddy",
        schema=schemas.MODELS,
        handler=handlers["workbuddy_models"],
        description="列出 WorkBuddy 桥接暴露的模型（必要时自动启动桥接）",
    )
    ctx.register_tool(
        name="workbuddy_sync",
        toolset="workbuddy",
        schema=schemas.SYNC,
        handler=handlers["workbuddy_sync"],
        description="把 WorkBuddy 模型写入 Hermes provider 配置（当前 profile 或全部 profile）",
    )

    def _on_session_start(session_id: str = "", model: str = "", platform: str = "", **_: object) -> None:
        """会话开始：确保桥接在跑；模型目录变化时刷新 provider（后台线程，不阻塞会话）。"""
        if not manager.setting_bool("autostart"):
            return
        threading.Thread(
            target=manager.session_bootstrap,
            name="workbuddy-bootstrap",
            daemon=True,
        ).start()

    ctx.register_hook("on_session_start", _on_session_start)

    setup_fn, handler_fn = wb_cli.build(manager)
    ctx.register_cli_command(
        name="workbuddy",
        help="WorkBuddy 桥接：status/start/stop/sync/cleanup/logs/doctor",
        setup_fn=setup_fn,
        handler_fn=handler_fn,
        description="把 WorkBuddy 桌面 App 的模型接入 Hermes",
    )

    ctx.register_command(
        "workbuddy",
        handler=lambda raw_args, **_: wb_cli.render_slash(manager, raw_args),
        description="WorkBuddy 桥接状态与控制（status/start/stop/sync/logs）",
        args_hint="status|start|stop|sync",
    )

    logger.debug("workbuddy plugin registered: 3 tools, on_session_start, /workbuddy, hermes workbuddy")
