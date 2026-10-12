import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT_SOURCES = [*ROOT.joinpath("web", "src").rglob("*.ts"), *ROOT.joinpath("web", "src").rglob("*.tsx"),
                  *ROOT.joinpath("worker-src", "src").rglob("*.js")]
# PAS app-role APIs: the SDK's roles module and any role-name check built on it. Club access must come from the server.
PAS_ROLE_CALL = re.compile(r"\bapp\.roles\b|\.roles\.(check|has|assign|revoke|list)\(|\bhasRole\(|\buseRoles\b")


class ClientAuthorizationTests(unittest.TestCase):
    def test_client_and_worker_code_never_check_pas_app_roles(self):
        self.assertTrue(CLIENT_SOURCES, "no client sources found")
        offenders = [str(path.relative_to(ROOT)) for path in CLIENT_SOURCES if PAS_ROLE_CALL.search(path.read_text())]
        self.assertEqual(offenders, [])

    def test_invites_do_not_assign_a_pas_role(self):
        for path in CLIENT_SOURCES:
            source = path.read_text()
            for match in re.finditer(r"invites\.create\(\s*\{", source):
                with self.subTest(file=str(path.relative_to(ROOT)), offset=match.start()):
                    call = source[match.end(): source.index("})", match.end())]
                    self.assertNotRegex(call, r"\brole\s*:")

    def test_club_manager_listings_include_convenors(self):
        source = (ROOT / "web" / "src" / "pages" / "ClubAdmin.tsx").read_text()
        self.assertIn("['admin', 'convenor', 'manager'].includes(x.role)", source)
        logic = (ROOT / "web" / "src" / "pages" / "importReviewLogic.ts").read_text()
        self.assertIn("const MANAGER_ROLES = ['admin', 'convenor', 'manager']", logic)


if __name__ == "__main__":
    unittest.main()
