import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Everything the browser renders: app sources (including comments, so they stay clean), the generated action catalog and manifest descriptions it shows.
RENDERED = [*ROOT.joinpath("web", "src").rglob("*.ts"), *ROOT.joinpath("web", "src").rglob("*.tsx")]
PLATFORM_TERMS = re.compile(r"\bPAS\b|platform|delegat|internal group|app worker", re.IGNORECASE)


class InviteCopyTests(unittest.TestCase):
    def test_rendered_sources_never_name_the_platform_or_its_invite_machinery(self):
        self.assertTrue(RENDERED)
        offenders = []
        for path in RENDERED:
            for number, line in enumerate(path.read_text().splitlines(), start=1):
                if PLATFORM_TERMS.search(line):
                    offenders.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()[:120]}")
        self.assertEqual(offenders, [])

    def test_manifest_descriptions_shown_in_the_admin_catalog_are_platform_free(self):
        tools = json.loads((ROOT / "mcp.json").read_text())["tools"]
        offenders = [tool["name"] for tool in tools if PLATFORM_TERMS.search(tool.get("description", ""))]
        self.assertEqual(offenders, [])

    def test_invites_keep_one_use_and_seven_day_expiry(self):
        source = (ROOT / "web" / "src" / "pages" / "ClubAdmin.tsx").read_text()
        self.assertIn("uses: 1, expiresIn: '7d'", source)


if __name__ == "__main__":
    unittest.main()
