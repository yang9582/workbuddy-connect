"""版本一致性：仓库里所有对外暴露版本号的地方必须同源，避免"上传的和我本地跑的不一样"。"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from workbuddy import __version__

ROOT = Path(__file__).resolve().parent.parent


class VersionConsistencyTests(unittest.TestCase):
    def test_plugin_yaml_matches_package_version(self) -> None:
        text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
        match = re.search(r"^version:\s*(\S+)", text, re.MULTILINE)
        self.assertIsNotNone(match, "plugin.yaml 缺少 version")
        self.assertEqual(match.group(1).strip("\"'"), __version__)

    def test_bundle_manifest_matches_package_version(self) -> None:
        manifest = json.loads((ROOT / "dsh" / "workbuddy-connect" / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], __version__)

    def test_bundle_manifest_is_generated_from_package_version(self) -> None:
        """生成的清单不能再硬编码版本号（否则改版本会漏改）。"""
        from workbuddy.harnesses.dsh import DshAdapter

        self.assertEqual(DshAdapter()._bundle_manifest()["version"], __version__)


if __name__ == "__main__":
    unittest.main()
