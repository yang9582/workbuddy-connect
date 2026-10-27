"""历史插件入口（Hermes）。

当前支持范围仅为 DSH：安装与使用见 README。此文件保留用于旧版本回滚，
实际实现位于 ``workbuddy`` 包。
"""

from .workbuddy.hermes_plugin import register  # noqa: F401
