"""开机自启：启动文件夹里的 VBS 的写入、查询与删除。"""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from workbuddy import autostart


@unittest.skipUnless(autostart.supported(), "只有 Windows 支持启动文件夹")
class AutostartTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"APPDATA": str(Path(self.tmp.name) / "Roaming")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repo = Path(self.tmp.name) / "repo"
        (self.repo / "bin").mkdir(parents=True)
        (self.repo / "bin" / "wbconnect.cmd").write_text("@echo off\n", encoding="utf-8")

    def test_install_then_uninstall(self) -> None:
        self.assertFalse(autostart.status(self.repo)["installed"])

        result = autostart.install(self.repo)
        self.assertTrue(result["ok"], result)
        shortcut = Path(result["shortcut"])
        self.assertTrue(shortcut.is_file())
        content = shortcut.read_text(encoding="utf-8")
        self.assertIn("wbconnect.cmd", content)
        self.assertIn(" start", content)
        self.assertTrue(autostart.status(self.repo)["installed"])

        removed = autostart.uninstall()
        self.assertTrue(removed["ok"])
        self.assertTrue(removed["removed"])
        self.assertFalse(shortcut.exists())

    def test_uninstall_is_idempotent(self) -> None:
        result = autostart.uninstall()
        self.assertTrue(result["ok"])
        self.assertFalse(result["removed"])

    def test_install_refuses_without_wrapper(self) -> None:
        lonely = Path(self.tmp.name) / "no-wrapper"
        lonely.mkdir()
        result = autostart.install(lonely)
        self.assertFalse(result["ok"])
        self.assertIn("找不到", result["reason"])

    def test_paths_with_spaces_are_quoted(self) -> None:
        spaced = Path(self.tmp.name) / "repo with space"
        (spaced / "bin").mkdir(parents=True)
        wrapper = spaced / "bin" / "wbconnect.cmd"
        wrapper.write_text("@echo off\n", encoding="utf-8")

        result = autostart.install(spaced)
        self.assertTrue(result["ok"], result)
        content = Path(result["shortcut"]).read_text(encoding="utf-8")
        self.assertIn(f'""{wrapper}""', content)


if __name__ == "__main__":
    unittest.main()
