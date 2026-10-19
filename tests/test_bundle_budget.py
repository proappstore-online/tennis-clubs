import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_bundle_budget", ROOT / "scripts" / "check-bundle-budget.py")
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)
BUDGETS = json.loads((ROOT / "docs" / "performance-budgets.json").read_text())["bundle_gzip_kb"]


class BundleBudgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.assets = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name: str, size: int):
        # Random bytes do not compress, so the gzipped size is close to the raw size.
        (self.assets / name).write_bytes(os.urandom(size))

    def test_small_bundle_passes(self):
        self.write("index-abc.js", 1024)
        self.write("index-abc.css", 1024)
        self.assertEqual(check.main(["check", str(self.assets)]), 0)

    def test_javascript_over_budget_fails_and_names_the_kind(self):
        self.write("index-abc.js", (BUDGETS["js"] + 60) * 1024)
        failures = check.over_budget(check.measure(self.assets), BUDGETS)
        self.assertEqual(len(failures), 1)
        self.assertIn("js:", failures[0])
        self.assertEqual(check.main(["check", str(self.assets)]), 1)

    def test_css_over_budget_fails(self):
        self.write("index-abc.css", (BUDGETS["css"] + 20) * 1024)
        self.assertEqual(check.main(["check", str(self.assets)]), 1)

    def test_missing_build_output_fails_with_a_hint(self):
        self.assertEqual(check.main(["check", str(self.assets / "missing")]), 1)

    def test_other_asset_types_are_not_counted(self):
        self.write("logo.png", (BUDGETS["js"] + 500) * 1024)
        sizes = check.measure(self.assets)
        self.assertEqual(sizes["js"], 0)
        self.assertEqual(sizes["css"], 0)
