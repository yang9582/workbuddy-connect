"""桥接内核记录（kernel.json / host-bundle.js）的一致性。"""

from __future__ import annotations

import unittest

from workbuddy import kernel


class KernelDescribeTests(unittest.TestCase):
    def test_recorded_hash_matches_file(self) -> None:
        info = kernel.describe()
        self.assertTrue(info.get("ok"), info)
        self.assertTrue(info["matchesRecord"])
        self.assertEqual(info["version"], "0.7.9")
        self.assertGreater(info["size"], 100_000)
        self.assertEqual(len(info["sha256"]), 64)


class KernelRefreshGuardTests(unittest.TestCase):
    def test_refuses_patched_source(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as tmp:
            patched = Path(tmp) / "host-bundle.js"
            patched.write_text("/* wb-compat:cn-kernel */ export const O = 1;", encoding="utf-8")
            original = kernel.find_source
            kernel.find_source = lambda: patched  # type: ignore[assignment]
            try:
                result = kernel.refresh()
            finally:
                kernel.find_source = original  # type: ignore[assignment]
        self.assertFalse(result["ok"])
        self.assertIn("dsh restore", result["error"])


if __name__ == "__main__":
    unittest.main()
