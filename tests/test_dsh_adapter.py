"""DSH 适配器：受管配置块渲染、幂等替换、.env 令牌写入。"""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from workbuddy.harnesses.dsh import BEGIN, DshAdapter

try:  # PyYAML 在项目运行环境里通常可用；不可用时跳过结构断言
    import yaml
except Exception:  # noqa: BLE001
    yaml = None

MODELS = [
    {"id": "a", "name": "Model A", "context_length": 1000, "max_tokens": 8},
    {"id": "b", "context_length": 2000},
]


class DshRenderingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"DSH_HOME": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.adapter = DshAdapter()

    def block(self, disable: bool = True) -> str:
        provider = self.adapter._render_provider(
            "workbuddy", "http://127.0.0.1:39621/v1", "WORKBUDDY_BRIDGE_TOKEN", MODELS,
        )
        return self.adapter._render_block([provider], disable_official=disable)

    def test_block_is_valid_yaml(self) -> None:
        if yaml is None:
            self.skipTest("PyYAML 不可用")
        data = yaml.safe_load(self.block())
        self.assertEqual(len(data), 2)
        self.assertEqual(data[0], {"id": "llm-workbuddy", "disabled": True})
        entry = data[1]
        self.assertEqual(entry["id"], "llm-pi-ai")
        providers = entry["config"]["providers"]
        self.assertEqual(sorted(providers), ["workbuddy"])
        provider = providers["workbuddy"]
        self.assertEqual(provider["api"], "openai-completions")
        self.assertEqual(provider["apiKeyEnv"], "WORKBUDDY_BRIDGE_TOKEN")
        self.assertEqual(provider["baseURL"], "http://127.0.0.1:39621/v1")
        self.assertEqual([m["id"] for m in provider["models"]], ["a", "b"])
        self.assertEqual(provider["models"][0]["contextWindow"], 1000)
        self.assertEqual(provider["models"][0]["maxTokens"], 8)
        self.assertEqual(provider["models"][0]["compat"]["maxTokensField"], "max_tokens")
        self.assertEqual(provider["models"][0]["input"], ["text"])

    def test_upsert_is_idempotent_and_keeps_user_content(self) -> None:
        text = "# 用户自己的配置\n- id: something\n  disabled: true\n"
        once = self.adapter._upsert_block(text, self.block())
        twice = self.adapter._upsert_block(once, self.block())
        self.assertEqual(once, twice)
        self.assertEqual(once.count(BEGIN), 1)
        self.assertIn("# 用户自己的配置", once)
        self.assertIn("- id: something", once)

    def test_strip_restores_original(self) -> None:
        text = "- id: something\n  disabled: true\n"
        restored = self.adapter._strip_block(self.adapter._upsert_block(text, self.block())).strip()
        self.assertEqual(restored, text.strip())

    def test_empty_flow_sequence_placeholder_is_replaced(self) -> None:
        """DSH 模板的 cordis.patch.yml 内容是 []；追加列表项必须仍然产出合法 YAML。"""
        text = "# 模板注释\n[]\n"
        merged = self.adapter._upsert_block(text, self.block())
        self.assertNotIn("\n[]", merged)
        if yaml is None:
            self.skipTest("PyYAML 不可用")
        parsed = yaml.safe_load(merged)
        self.assertIsInstance(parsed, list)
        self.assertEqual(parsed[-1]["id"], "llm-pi-ai")

    def test_bare_empty_brackets_only_removed_at_top_level(self) -> None:
        text = "- id: x\n  config:\n    items: []\n"
        merged = self.adapter._upsert_block(text, self.block())
        self.assertIn("items: []", merged)

    def test_official_row_omitted_when_not_needed(self) -> None:
        self.assertNotIn("llm-workbuddy", self.block(disable=False))

    def test_yaml_scalar_escaping(self) -> None:
        block = self.adapter._render_provider(
            "workbuddy", "http://127.0.0.1:1/v1", "TOKEN", [{"id": "it's", "name": "a 'quoted' name"}],
        )
        if yaml is None:
            self.skipTest("PyYAML 不可用")
        parsed = yaml.safe_load("- id: llm-pi-ai\n  config:\n    providers:\n" + "\n".join(block))
        self.assertEqual(parsed[0]["config"]["providers"]["workbuddy"]["models"][0]["id"], "it's")


class DshEnvTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"DSH_HOME": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.adapter = DshAdapter()

    def test_appends_then_updates_without_touching_other_lines(self) -> None:
        env_path = Path(self.tmp.name) / ".env"
        env_path.write_text("WORKBUDDY_ELECTRON_BIN=D:\\app.exe\nOTHER=1\n", encoding="utf-8")

        changed = self.adapter._write_env({"WORKBUDDY_BRIDGE_TOKEN": "tok-1"})
        self.assertEqual(changed, ["WORKBUDDY_BRIDGE_TOKEN"])
        text = env_path.read_text(encoding="utf-8")
        self.assertIn("WORKBUDDY_ELECTRON_BIN=D:\\app.exe", text)
        self.assertIn("OTHER=1", text)
        self.assertIn("WORKBUDDY_BRIDGE_TOKEN=tok-1", text)

        self.adapter._write_env({"WORKBUDDY_BRIDGE_TOKEN": "tok-2"})
        text = env_path.read_text(encoding="utf-8")
        self.assertIn("WORKBUDDY_BRIDGE_TOKEN=tok-2", text)
        self.assertEqual(text.count("WORKBUDDY_BRIDGE_TOKEN="), 1)

    def test_no_change_reports_empty(self) -> None:
        self.adapter._write_env({"WORKBUDDY_BRIDGE_TOKEN": "same"})
        self.assertEqual(self.adapter._write_env({"WORKBUDDY_BRIDGE_TOKEN": "same"}), [])


class DshBundleTests(unittest.TestCase):
    """DSH bundle 包：清单格式、patch 内容、安装后的路由。"""

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"DSH_HOME": str(Path(self.tmp.name) / "dsh")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.adapter = DshAdapter()
        self.bundle = Path(self.tmp.name) / "bundle"
        mock.patch.object(self.adapter, "bundle_dir", return_value=self.bundle).start()
        self.addCleanup(mock.patch.stopall)

    def _providers(self):
        return [self.adapter._render_provider(
            "workbuddy", "http://127.0.0.1:39621/v1", "WORKBUDDY_BRIDGE_TOKEN", MODELS,
        )]

    def test_writes_manifest_and_valid_patch(self) -> None:
        import json

        with mock.patch.object(self.adapter, "_collect", return_value=(self._providers(), {"T": "v"}, [])):
            lines = self.adapter.write_bundle(manager=None)

        self.assertTrue(self.bundle.is_dir())
        manifest = json.loads((self.bundle / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "workbuddy-connect")
        self.assertEqual(manifest["dsh"]["bundle"]["patch"], "./cordis.patch.yml")

        if yaml is None:
            self.skipTest("PyYAML 不可用")
        data = yaml.safe_load((self.bundle / "cordis.patch.yml").read_text(encoding="utf-8"))
        # 临时 DSH_HOME 里没有官方插件，因此不写 llm-workbuddy 关闭行
        self.assertEqual([row["id"] for row in data], ["llm-pi-ai"])
        self.assertIn("已生成 bundle", lines[0])

    def test_no_providers_is_an_error_not_a_write(self) -> None:
        with mock.patch.object(self.adapter, "_collect", return_value=([], {}, ["桥接未启动"])):
            lines = self.adapter.write_bundle(manager=None)
        self.assertIn("没有可写入的 provider", lines[0])
        self.assertFalse(self.bundle.exists())

    def test_install_prefers_bundle_when_installed(self) -> None:
        with mock.patch.object(self.adapter, "bundle_installed", return_value=True), \
             mock.patch.object(self.adapter, "write_bundle", return_value=["refreshed"]) as write:
            lines = self.adapter.install(manager=None)
        write.assert_called_once()
        self.assertIn("refreshed", lines)


if __name__ == "__main__":
    unittest.main()
