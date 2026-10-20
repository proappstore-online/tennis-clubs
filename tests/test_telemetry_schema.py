import re
import unittest
from pathlib import Path

# The telemetry schema (issue #30). web/src/telemetry/events.ts is the source: every event name, its fields and their
# validators are read from it, so this test checks the definitions the app really ships, not a copy of them.
ROOT = Path(__file__).resolve().parents[1]
EVENTS = (ROOT / "web" / "src" / "telemetry" / "events.ts").read_text(encoding="utf-8")

# The events the issue asks for, by what they report.
REQUIRED = {
    "import.completed": "imports",
    "import.anomaly": "data anomalies in imports",
    "score.submitted": "score submission",
    "write.refused": "permission denials and refused writes",
    "page.error": "public page errors",
    "page.load": "public page load performance",
    "page.view": "signed-in page render performance",
}

# Field names that would carry a person, a contact, a credential or an address. No event may define one.
PERSONAL_FIELDS = {"name", "email", "ip", "ip_address", "user_id", "userid", "actor_user_id", "display_name", "player_name",
                   "phone", "contact", "address", "token", "login", "dob", "date_of_birth", "password", "secret", "invite_code",
                   "message", "remediation", "source_row", "source_key", "display", "person", "player"}
# Validators a field may use. Each one admits only a count, a duration, an enumerated value or a lower-case token.
FIXED_VALIDATORS = {"count", "millis", "token", "KIND", "OUTCOME", "nullable(OUTCOME)"}


def schema_block():
    start = EVENTS.index("const SCHEMAS: Record<EventName, Record<string, Check>> = {")
    end = EVENTS.index("\n}\n", start)
    return EVENTS[start:end]


def parse_schemas():
    events = {}
    for name, body in re.findall(r"^\s*'([a-z.]+)': \{(.*)\},?$", schema_block(), re.M):
        events[name] = dict(re.findall(r"(\w+): ((?:oneOf\([^)]*\)|nullable\([^)]*\)|[A-Za-z_]+))", body))
    return events


def parse_levels():
    start = EVENTS.index("const LEVEL: Record<EventName, 'info' | 'warn'> = {")
    end = EVENTS.index("\n}\n", start)
    return dict(re.findall(r"^\s*'([a-z.]+)': '(info|warn)',?$", EVENTS[start:end], re.M))


def parse_type_names():
    return re.findall(r"^\s*\| \{ name: '([a-z.]+)';", EVENTS, re.M)


class TelemetrySchemaTests(unittest.TestCase):
    def test_the_schema_defines_every_event_the_issue_asks_for(self):
        schemas = parse_schemas()
        for name, purpose in REQUIRED.items():
            with self.subTest(event=name, purpose=purpose):
                self.assertIn(name, schemas)

    def test_every_event_has_a_level_and_is_in_the_public_type(self):
        schemas = parse_schemas()
        self.assertEqual(sorted(parse_levels()), sorted(schemas))
        self.assertEqual(sorted(parse_type_names()), sorted(schemas))

    def test_no_event_defines_a_personal_or_contact_field(self):
        for name, fields in parse_schemas().items():
            for field in fields:
                with self.subTest(event=name, field=field):
                    self.assertNotIn(field, PERSONAL_FIELDS)
                    self.assertIsNone(re.search(r"email|phone|address|password|token|user|player|name$", field))

    def test_every_field_uses_a_fixed_validator(self):
        for name, fields in parse_schemas().items():
            for field, validator in fields.items():
                with self.subTest(event=name, field=field):
                    self.assertTrue(validator in FIXED_VALIDATORS or validator.startswith("oneOf("), validator)

    def test_enumerated_fields_list_only_fixed_values(self):
        for name, fields in parse_schemas().items():
            for field, validator in fields.items():
                if validator.startswith("oneOf("):
                    with self.subTest(event=name, field=field):
                        values = re.findall(r"'([^']+)'", validator)
                        self.assertTrue(values)
                        for value in values:
                            self.assertRegex(value, r"^[a-z_]+$")

    def test_the_routes_are_fixed_names(self):
        pages = (ROOT / "web" / "src" / "telemetry" / "pages.ts").read_text(encoding="utf-8")
        self.assertIn("if (path.startsWith('/join/')) return 'join'", pages, "invitation links must not be reported by path")


if __name__ == "__main__":
    unittest.main()
