"""service 的 P0 行为：端口一致性、stop 归属校验。"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from workbuddy import service

INST = service.INSTANCES[0]


def make_manager(tmp: str) -> service.BridgeManager:
    manager = service.BridgeManager(None)
    manager.data_dir = lambda: Path(tmp)  # type: ignore[method-assign]
    manager.port = lambda inst: 39621  # type: ignore[method-assign]
    return manager


class PrepareConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.manager = make_manager(self.tmp.name)

    def test_creates_config_with_current_port(self) -> None:
        path = self.manager._prepare_config(INST, 39621)
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["port"], 39621)
        self.assertEqual(data["variant"], "workbuddy")
        self.assertEqual(data["catalogRefreshMinutes"], 10)

    def test_rewrites_port_but_keeps_other_keys(self) -> None:
        path = self.manager.config_path(INST)
        path.write_text(json.dumps({
            "port": 39621,
            "variant": "workbuddy",
            "anthropicSystemMode": "pass",
            "creditsCacheSeconds": 5,
        }), encoding="utf-8")

        self.manager._prepare_config(INST, 40000)

        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["port"], 40000, "端口设置必须覆盖配置文件里的旧值")
        self.assertEqual(data["anthropicSystemMode"], "pass")
        self.assertEqual(data["creditsCacheSeconds"], 5)


class StopOwnershipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.manager = make_manager(self.tmp.name)

    def _prepare(self, owns: bool, recorded, name: str = "node.exe") -> None:
        self.manager._pids_on_port = lambda port: [4242]  # type: ignore[method-assign]
        self.manager._owns_port = lambda inst: owns  # type: ignore[method-assign]
        self.manager._read_recorded_pid = lambda inst: recorded  # type: ignore[method-assign]
        self.manager._process_name = staticmethod(lambda pid: name)  # type: ignore[method-assign]
        self.manager.is_port_open = lambda port: False  # type: ignore[method-assign]

    def test_refuses_when_port_belongs_to_someone_else(self) -> None:
        self._prepare(owns=False, recorded=None, name="chrome.exe")
        with mock.patch.object(service.subprocess, "run") as run:
            result = self.manager.stop(INST)
        run.assert_not_called()
        self.assertTrue(result["refused"])
        self.assertFalse(result["stopped"])

    def test_refuses_stale_pid_when_process_is_not_node(self) -> None:
        self._prepare(owns=False, recorded=4242, name="chrome.exe")
        with mock.patch.object(service.subprocess, "run") as run:
            result = self.manager.stop(INST)
        run.assert_not_called()
        self.assertTrue(result["refused"])

    def test_kills_when_health_identifies_our_bridge(self) -> None:
        self._prepare(owns=True, recorded=None)
        with mock.patch.object(service.subprocess, "run") as run:
            result = self.manager.stop(INST)
        run.assert_called_once()
        self.assertTrue(result["stopped"])
        self.assertTrue(result["ok"])

    def test_kills_when_pidfile_matches_a_node_process(self) -> None:
        self._prepare(owns=False, recorded=4242, name="node.exe")
        with mock.patch.object(service.subprocess, "run") as run:
            result = self.manager.stop(INST)
        run.assert_called_once()
        self.assertTrue(result["stopped"])

    def test_no_listener_is_a_noop(self) -> None:
        self.manager._pids_on_port = lambda port: []  # type: ignore[method-assign]
        result = self.manager.stop(INST)
        self.assertTrue(result["ok"])
        self.assertFalse(result["stopped"])


class StartPortTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.manager = make_manager(self.tmp.name)

    def test_occupied_port_with_our_bridge_is_not_restarted(self) -> None:
        self.manager.health = lambda inst: {"ok": False, "error": "HTTP 401"}  # type: ignore[method-assign]
        self.manager.is_port_open = lambda port: True  # type: ignore[method-assign]
        self.manager._owns_port = lambda inst: True  # type: ignore[method-assign]
        with mock.patch.object(service.subprocess, "Popen") as popen:
            result = self.manager.start(INST)
        popen.assert_not_called()
        self.assertTrue(result["already_running"])

    def test_occupied_port_with_foreign_process_raises(self) -> None:
        self.manager.health = lambda inst: {"ok": False, "error": "HTTP 500"}  # type: ignore[method-assign]
        self.manager.is_port_open = lambda port: True  # type: ignore[method-assign]
        self.manager._owns_port = lambda inst: False  # type: ignore[method-assign]
        with self.assertRaises(RuntimeError) as ctx:
            self.manager.start(INST)
        self.assertIn("占用", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
