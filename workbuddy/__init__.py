"""workbuddy-connect —— WorkBuddy 模型接入多家 agent harness 的核心包。

- ``service``：桥接进程管理（启动/停止/健康检查/模型探测）
- ``providers_sync``：写 provider 配置（Hermes 原生格式）
- ``cli``/``cli_main``：Hermes 内命令与 ``wbconnect`` 独立 CLI
- ``harnesses``：各 harness 的安装适配器（Hermes / Claude Code / Codex / OpenClaw / DSH）
"""

__version__ = "2.0.0"
