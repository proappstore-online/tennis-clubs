import json
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / 'migrations.json').read_text())['migrations']
TOOLS = {tool['name']: tool for tool in json.loads((ROOT / 'mcp.json').read_text())['tools']}


class VenueDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        for migration in MIGRATIONS:
            self.db.executescript(migration['sql'])
        self.db.executemany('INSERT INTO organizations(id,name,slug,created_at) VALUES(?,?,?,1)', [('a','A','a'),('b','B','b')])
        self.db.executemany('INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES(?,?,?,?,?,1,1)', [('ma','a','manager','manager','Manager'),('mb','b','other-manager','manager','Other')])
        self.db.execute("INSERT INTO venues(id,org_id,name,address,map_url,notes,convenor_phone,created_at) VALUES('va','a','Old courts','1 Court Rd','https://maps.example/a','Use side gate','0400000000',1)")
        self.db.executemany('INSERT INTO teams(id,org_id,name,created_at) VALUES(?,?,?,1)', [('ta','a','Team A'),('tb','a','Team B'),('tc','b','Team C')])
        self.db.execute("INSERT INTO fixtures(id,org_id,home_team_id,away_team_id,venue_id,starts_at,created_at) VALUES('fa','a','ta','tb','va','2026-10-11T09:00:00+11:00',1)")

    def tearDown(self):
        self.db.close()

    def call(self, action, user='manager', **values):
        return self.db.execute(TOOLS[action]['sql'], {'__user_id': user, '__now': 10, **values})

    def test_manager_can_update_shared_venue_and_linked_fixture_resolves_new_details(self):
        self.call('update_venue', venue_id='va', org_id='a', name='New courts', address='2 Court Rd', map_url='https://maps.example/b', notes='Accessible entrance', convenor_phone='0411222333')
        # Resolve through the shared foreign-key relation, as player fixture queries do.
        venue = self.db.execute('SELECT v.name,v.address,v.map_url,v.notes FROM fixtures f JOIN venues v ON v.id=f.venue_id WHERE f.id=?', ('fa',)).fetchone()
        self.assertEqual(tuple(venue), ('New courts','2 Court Rd','https://maps.example/b','Accessible entrance'))

    def test_venue_edits_are_limited_to_managers_of_the_owning_club(self):
        self.call('update_venue', user='other-manager', venue_id='va', org_id='a', name='Compromised', address='', map_url='', notes='', convenor_phone='')
        self.assertEqual(self.db.execute("SELECT name FROM venues WHERE id='va'").fetchone()[0], 'Old courts')

    def test_player_fixture_projection_includes_travel_notes_but_not_private_phone(self):
        sql = TOOLS['list_my_fixtures']['sql']
        self.assertIn('v.notes AS venue_notes', sql)
        self.assertNotIn('convenor_phone', sql)
        self.assertNotIn('phone', sql.lower())

    def test_manager_venue_directory_includes_private_convenor_phone(self):
        row = self.call('list_club_venues', org_id='a').fetchone()
        self.assertEqual(row['convenor_phone'], '0400000000')
        self.assertIn('convenor_phone', TOOLS['create_venue']['sql'])


if __name__ == '__main__':
    unittest.main()
