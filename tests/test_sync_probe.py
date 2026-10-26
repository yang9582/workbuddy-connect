"""providers_sync 的探测开关与三态处理。"""

from __future__ import annotations

import unittest
from unittest import mock

from workbuddy import providers_sync, service

INST = service.INSTANCES[0]
MODELS = [
    {"id": "a", "name": "A", "context_length": 1000},
    {"id": "b", "name": "B", "context_length": 2000},
    {"id": "c", "name": "C", "context_length": 3000},
]


class FakeManager:
    def __init__(self, verdicts=None, setting=True, instances=(INST,)):
        self.verdicts = verdicts or {}
        self.setting = setting
        self.instances_list = list(instances)
        self.probed = 0

    def models(self, inst):
        return MODELS

    def ensure(self, inst):
        return {"ok": True}

    def probe_models(self, inst, models, *, force=False):
        self.probed += 1
        return self.verdicts

    def token(self, inst):
        return "token-value"

    def port(self, inst):
        return 39621

    def instances(self):
        return self.instances_list

    def setting_bool(self, key):
        return bool(self.setting)

    def setting_str(self, key):
        return ""


class SyncInstanceTests(unittest.TestCase):
    def _run(self, manager, *, probe):
        with mock.patch.object(providers_sync, "_set") as set_mock, \
             mock.patch.object(providers_sync, "_get", return_value=""):
            result = providers_sync.sync_instance(INST, manager, None, probe=probe)
        return result, set_mock

    def test_probe_false_skips_probing(self) -> None:
        manager = FakeManager(verdicts={"b": "blocked"})
        result, _ = self._run(manager, probe=False)
        self.assertEqual(manager.probed, 0)
        self.assertEqual(result["models"], 3, "不探测时应写入目录里的全部模型")
        self.assertEqual(result["models_blocked"], [])
        self.assertEqual(result["models_unverified"], [])

    def test_blocked_models_are_dropped_and_unknown_reported(self) -> None:
        manager = FakeManager(verdicts={"b": "blocked", "c": "unknown"})
        result, _ = self._run(manager, probe=True)
        self.assertEqual(manager.probed, 1)
        self.assertEqual(result["models_total"], 3)
        self.assertEqual(result["models"], 2)
        self.assertEqual(result["models_blocked"], ["b"])
        self.assertEqual(result["models_unverified"], ["c"], "探测失败要显式告知，而不是当成可用")


class SyncProbeSettingTests(unittest.TestCase):
    def test_default_probe_follows_plugin_setting(self) -> None:
        manager = FakeManager(setting=False)
        with mock.patch.object(providers_sync, "resolve_targets", return_value=[None]), \
             mock.patch.object(providers_sync, "sync_instance", return_value={}) as sync_instance:
            providers_sync.sync(manager)
        _, kwargs = sync_instance.call_args
        self.assertFalse(kwargs["probe"])

    def test_explicit_probe_overrides_setting(self) -> None:
        manager = FakeManager(setting=False)
        with mock.patch.object(providers_sync, "resolve_targets", return_value=[None]), \
             mock.patch.object(providers_sync, "sync_instance", return_value={}) as sync_instance:
            providers_sync.sync(manager, probe=True)
        _, kwargs = sync_instance.call_args
        self.assertTrue(kwargs["probe"])


class ProfilesRootTests(unittest.TestCase):
    def test_falls_back_to_hermes_home_when_running_outside_hermes(self) -> None:
        try:
            import hermes_constants  # noqa: F401  (只有 Hermes 进程内可用)
        except Exception:
            pass
        else:
            self.skipTest("测试环境里 Hermes 常量可用，走的是另一条分支")

        import os
        from pathlib import Path
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"HERMES_HOME": str(Path(tmp) / "hermes")}):
                self.assertEqual(
                    providers_sync.profiles_root(),
                    Path(tmp) / "hermes" / "profiles",
                )


if __name__ == "__main__":
    unittest.main()
