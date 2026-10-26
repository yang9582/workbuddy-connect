"""端到端 doctor：探测汇总、Hermes provider 检查、渲染。"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from workbuddy import doctor, service

INST = service.INSTANCES[0]


class FakeManager:
    def __init__(self, tmp: str):
        self.tmp = tmp

    def instances(self):
        return [INST]

    def setting_bool(self, key):
        return True

    def port(self, inst):
        return 39621

    def probe_cache_path(self, inst):
        return Path(self.tmp) / "probe.json"

    def is_port_open(self, port):
        return False

    def health(self, inst):
        return {"ok": False, "error": "not running"}

    def token(self, inst):
        return ""

    def node_path(self):
        return "node"


class ProbeCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.manager = FakeManager(self.tmp.name)

    def test_missing_cache_is_a_warning(self) -> None:
        checks = doctor._probe_checks(self.manager)
        self.assertEqual(checks[0]["status"], "warn")
        self.assertIn("还没有探测结果", checks[0]["detail"])

    def test_unknown_verdicts_are_surfaced(self) -> None:
        self.manager.probe_cache_path(INST).write_text(
            json.dumps({"results": {"a": "ok", "b": "blocked", "c": "unknown"}}), encoding="utf-8",
        )
        checks = doctor._probe_checks(self.manager)
        self.assertEqual(checks[0]["status"], "warn")
        self.assertIn("可用 1", checks[0]["detail"])
        self.assertIn("未验证 1", checks[0]["detail"])

    def test_all_ok_is_ok(self) -> None:
        self.manager.probe_cache_path(INST).write_text(
            json.dumps({"results": {"a": "ok", "b": "blocked"}}), encoding="utf-8",
        )
        checks = doctor._probe_checks(self.manager)
        self.assertEqual(checks[0]["status"], "ok")


class HermesCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "hermes"
        self.home.mkdir()
        patcher = mock.patch.dict(os.environ, {"HERMES_HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.manager = FakeManager(self.tmp.name)

    def test_missing_provider_is_reported_with_hint(self) -> None:
        (self.home / "config.yaml").write_text("providers:\n  other:\n    base_url: x\n", encoding="utf-8")
        checks = doctor._hermes_checks(self.manager)
        labels = [item["label"] for item in checks]
        self.assertIn("Hermes/default", labels)
        entry = next(item for item in checks if item["label"] == "Hermes/default")
        self.assertEqual(entry["status"], "warn")
        self.assertIn("缺 provider", entry["detail"])
        self.assertIn("wbconnect sync", entry["hint"])

    def test_missing_env_token_is_reported(self) -> None:
        (self.home / "config.yaml").write_text(
            "providers:\n"
            "  workbuddy:\n"
            "    base_url: http://127.0.0.1:39621/v1\n"
            "  workbuddy-ai:\n"
            "    base_url: http://127.0.0.1:39622/v1\n",
            encoding="utf-8",
        )
        entry = next(item for item in doctor._hermes_checks(self.manager) if item["label"] == "Hermes/default")
        self.assertEqual(entry["status"], "warn")
        self.assertIn(".env 缺令牌", entry["detail"])

    def test_wrong_port_is_reported(self) -> None:
        (self.home / "config.yaml").write_text(
            "providers:\n  workbuddy:\n    base_url: http://127.0.0.1:1/v1\n", encoding="utf-8",
        )
        entry = next(item for item in doctor._hermes_checks(self.manager) if item["label"] == "Hermes/default")
        self.assertIn("端口不匹配", entry["detail"])


class DeployCheckTests(unittest.TestCase):
    def test_reports_missing_stale_and_current(self) -> None:
        from workbuddy import __version__

        with TemporaryDirectory() as tmp:
            home = Path(tmp) / "hermes"
            home.mkdir()
            with mock.patch.dict(os.environ, {"HERMES_HOME": str(home)}):
                self.assertEqual(doctor._deploy_checks()[0]["status"], "warn")

                plugin = home / "plugins" / "workbuddy"
                plugin.mkdir(parents=True)
                (plugin / "plugin.yaml").write_text("name: workbuddy\n", encoding="utf-8")
                (plugin / ".workbuddy-version").write_text(f"{__version__}\n", encoding="utf-8")
                self.assertEqual(doctor._deploy_checks()[0]["status"], "ok")

                (plugin / ".workbuddy-version").write_text("0.1\n", encoding="utf-8")
                stale = doctor._deploy_checks()[0]
                self.assertEqual(stale["status"], "warn")
                self.assertIn("0.1", stale["detail"])


class RenderTests(unittest.TestCase):
    def test_render_contains_sections_and_summary(self) -> None:
        report = {
            "ok": False,
            "counts": {"ok": 1, "warn": 1, "fail": 0},
            "sections": [{
                "title": "桥接",
                "checks": [
                    {"label": "A", "status": "ok", "detail": "fine", "hint": ""},
                    {"label": "B", "status": "warn", "detail": "meh", "hint": "fix it"},
                ],
            }],
        }
        text = doctor.render(report)
        self.assertIn("■ 桥接", text)
        self.assertIn("✓ A  fine", text)
        self.assertIn("→ fix it", text)
        self.assertIn("1 正常 / 1 警告 / 0 失败", text)

    def test_collect_marks_failure_when_bridge_down(self) -> None:
        with TemporaryDirectory() as tmp:
            report = doctor.collect(FakeManager(tmp))
        self.assertFalse(report["ok"])
        self.assertGreaterEqual(report["counts"]["fail"], 1)


if __name__ == "__main__":
    unittest.main()
