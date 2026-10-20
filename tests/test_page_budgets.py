import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Page-level performance budgets (issue #30). scripts/check-page-budget.py measures each page on the seeded association
# and exits non-zero when a page exceeds its budget. These tests run the script on the real budgets, and on budgets it
# must fail, so the failure path is exercised as well as the pass path.
ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check-page-budget.py"
BUDGETS = ROOT / "docs" / "performance-budgets.json"
DOC = (ROOT / "docs" / "performance-budgets.md").read_text(encoding="utf-8")

_spec = importlib.util.spec_from_file_location("check_page_budget", SCRIPT)
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)


def run_script(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, cwd=ROOT)


class PageBudgetTests(unittest.TestCase):
    def test_the_budget_file_and_the_check_name_the_same_pages(self):
        pages = json.loads(BUDGETS.read_text(encoding="utf-8"))["pages"]
        self.assertEqual(sorted(pages), sorted(check.PAGE_CALLS))
        for name, spec in pages.items():
            with self.subTest(page=name):
                self.assertGreater(spec["budget_ms"], 0)
                self.assertTrue(spec["description"].strip())

    def test_every_page_call_is_an_action_in_the_manifest(self):
        tools = {tool["name"] for tool in json.loads((ROOT / "mcp.json").read_text(encoding="utf-8"))["tools"]}
        for page, calls in check.PAGE_CALLS.items():
            for tool, _ in calls:
                with self.subTest(page=page, tool=tool):
                    self.assertIn(tool, tools)

    def test_every_page_is_within_its_budget_on_the_real_budgets(self):
        result = run_script(str(BUDGETS), "--runs", "3")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for page in check.PAGE_CALLS:
            self.assertIn(f"ok   {page}:", result.stdout)

    def test_a_page_over_its_budget_fails_the_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            budgets = Path(tmp) / "budgets.json"
            budgets.write_text(json.dumps({"pages": {"fixtures": {"budget_ms": 0.001, "description": "forced to fail"},
                                                     "directory": {"budget_ms": 50000, "description": "generous"}}}), encoding="utf-8")
            result = run_script(str(budgets), "--runs", "1")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("FAIL fixtures:", result.stdout)
        self.assertNotIn("FAIL directory:", result.stdout)

    def test_a_budget_file_that_omits_a_page_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            budgets = Path(tmp) / "budgets.json"
            budgets.write_text(json.dumps({"pages": {"fixtures": {"budget_ms": 100, "description": "only one page"}}}), encoding="utf-8")
            result = run_script(str(budgets), "--runs", "1")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("directory", result.stdout)

    def test_a_malformed_budget_file_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            budgets = Path(tmp) / "budgets.json"
            budgets.write_text("{not json", encoding="utf-8")
            result = run_script(str(budgets), "--runs", "1")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

    def test_the_page_budgets_are_documented(self):
        for page, spec in json.loads(BUDGETS.read_text(encoding="utf-8"))["pages"].items():
            with self.subTest(page=page):
                self.assertIn(f"`{page}`", DOC)
                self.assertIn(f"{spec['budget_ms']} ms", DOC)


if __name__ == "__main__":
    unittest.main()
