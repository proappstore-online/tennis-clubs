import re
import unittest
from pathlib import Path

# Privacy of what the app loads and shows (issues #29 and #34). Venue maps are plain links, no map is embedded, no
# location is read outside the consent gate, and every third-party host the app loads is named here with its reason.
ROOT = Path(__file__).resolve().parents[1]
WEB_SRC = ROOT / "web" / "src"
INDEX = ROOT / "web" / "index.html"

ALLOWED_HOSTS = {
    "tennis-clubs.proappstore.online": "the app's own address, used for canonical and share metadata",
    "api.proappstore.online": "the platform's analytics script, loaded on every page; the platform owns its consent and retention",
    "fonts.googleapis.com": "web fonts, loaded on every page; sends the visitor's IP address, not location (self-hosting is a follow-up)",
    "fonts.gstatic.com": "web font files, the same provider as above",
}
MAP_PROVIDERS = re.compile(r"openstreetmap|google\.[a-z.]+/maps|maps\.google|maps\.apple|mapbox|leaflet|here\.com|bing\.com/maps|tile\.|<iframe", re.I)
HOST = re.compile(r"https?://([a-zA-Z0-9.-]+)")
GEOLOCATION = re.compile(r"geolocation|watchPosition", re.I)
CONSENT_MODULE = Path("location") / "consent.ts"


def sources(root):
    return [path for path in root.rglob("*") if path.suffix in {".ts", ".tsx", ".js"} and "generated" not in path.parts]


class PrivacySurfaceTests(unittest.TestCase):
    def test_every_third_party_host_the_app_loads_is_named_with_a_reason(self):
        loaded = set()
        for path in sources(WEB_SRC) + [INDEX]:
            loaded.update(HOST.findall(path.read_text(encoding="utf-8")))
        unknown = sorted(host for host in loaded if host not in ALLOWED_HOSTS)
        self.assertEqual(unknown, [], "a new third-party host needs a reason in ALLOWED_HOSTS and in docs/privacy-data-classification.md")
        for host, reason in ALLOWED_HOSTS.items():
            self.assertTrue(reason.strip())

    def test_no_map_is_embedded_and_no_map_provider_is_loaded(self):
        offenders = []
        for path in sources(WEB_SRC) + [INDEX]:
            text = path.read_text(encoding="utf-8")
            if MAP_PROVIDERS.search(text):
                offenders.append(path.relative_to(ROOT).as_posix())
        self.assertEqual(offenders, [])

    def test_the_page_loads_only_its_own_script_and_the_platform_analytics(self):
        html = INDEX.read_text(encoding="utf-8")
        scripts = re.findall(r'<script[^>]*\ssrc="([^"]+)"', html)
        self.assertEqual(sorted(scripts), sorted(["https://api.proappstore.online/v1/analytics.js?app=tennis-clubs", "/src/main.tsx"]))

    def test_device_location_is_read_only_by_the_consent_module(self):
        offenders = []
        for path in sources(WEB_SRC):
            if path.relative_to(WEB_SRC) == CONSENT_MODULE:
                continue
            if GEOLOCATION.search(path.read_text(encoding="utf-8")):
                offenders.append(path.relative_to(ROOT).as_posix())
        self.assertEqual(offenders, [])
        consent = (WEB_SRC / CONSENT_MODULE).read_text(encoding="utf-8")
        self.assertIn("hasLocationConsent(await getLocationConsent(app))", consent, "consent must be checked before any location request")


if __name__ == "__main__":
    unittest.main()
