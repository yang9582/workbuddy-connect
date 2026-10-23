"""Hermes 插件入口。

实现全部在 ``workbuddy`` 包里（同一份代码也被 ``wbconnect`` CLI 和其它
harness 的适配器复用）。Hermes 插件加载器只要求这里的 ``register(ctx)``。
"""

from .workbuddy.hermes_plugin import register  # noqa: F401
