"""Deterministic association-scale seed data for the performance budgets (issue #35).

Synthetic only: every name, address and identifier is generated here, and no personal data is used.
Each club is an organisation. Fixtures are played inside one club, because list_my_fixtures only returns fixtures
whose two teams belong to the same organisation; external opponents are teams flagged is_external in that club.
"""

import random
from datetime import date, datetime, timedelta, timezone

SEED = 20261020
# The association the budgets are measured against. The budgets file asserts these minimums so a smaller seed cannot pass.
SCALE = {"clubs": 40, "seasons": 3, "divisions_per_season": 3, "own_teams_per_division": 4, "external_teams_per_division": 4}
VIEWER = "viewer"
VIEWER_CLUB = "club-000"
VIEWER_SEASON = 2
# The viewer's fixture list is read as at this instant; fixtures before it are "past", the rest "upcoming".
AS_AT = date(2026, 10, 20)


def _iso(day: date, hour: int) -> str:
    return datetime(day.year, day.month, day.day, hour, 0, tzinfo=timezone(timedelta(hours=11))).isoformat()


def seed_association(db, rng_seed: int = SEED) -> dict:
    """Fills an empty database (migrations already applied) with the association. Returns row counts."""
    rng = random.Random(rng_seed)
    orgs, memberships, seasons, divisions, venues, externals, teams, players, fixtures, roster = ([] for _ in range(10))
    for c in range(SCALE["clubs"]):
        club = f"club-{c:03d}"
        orgs.append((club, f"Club {c:03d}", club, None, 1, None))
        memberships.append((f"{club}-m-admin", club, f"{club}-admin", "admin", "Admin", 1, 1))
        for v in range(3):
            venues.append((f"{club}-v{v}", club, f"Court {v + 1}", f"{v + 1} Racquet Road", None, None, 1))
        if club == VIEWER_CLUB:
            memberships.append((f"{club}-m-viewer", club, VIEWER, "player", "Viewer", 1, 1))
        for s in range(SCALE["seasons"]):
            season = f"{club}-s{s}"
            year = 2024 + s
            seasons.append((season, club, f"{year}", f"{year}-02-01", f"{year}-12-31", "active", 1))
            for d in range(SCALE["divisions_per_season"]):
                division = f"{season}-d{d}"
                divisions.append((division, season, f"Division {d + 1}", None, 1))
                own = [f"{division}-t{t}" for t in range(SCALE["own_teams_per_division"])]
                ext = [f"{division}-x{x}" for x in range(SCALE["external_teams_per_division"])]
                for team_id in own:
                    teams.append((team_id, club, division, team_id, None, None, 0, 1))
                for x, team_id in enumerate(ext):
                    # Each opponent is its own external club: the schema allows one team per external club per organisation.
                    external = f"{division}-ec{x}"
                    externals.append((external, club, f"Opponent {s}-{d}-{x}", f"opponent {s}-{d}-{x}", None, 1))
                    teams.append((team_id, club, division, f"Opponent {s}-{d}-{x}", None, external, 1, 1))
                for team_id in own:
                    for p in range(10):
                        players.append((team_id, f"{team_id}-p{p}", f"Player {p}", 1))
                if s == VIEWER_SEASON and d == 0 and club == VIEWER_CLUB:
                    players.extend([(own[0], VIEWER, "Viewer", 1), (own[1], VIEWER, "Viewer", 1)])

                # Double round robin: every team hosts every other team once.
                everyone = own + ext
                pairings = [(h, a) for h in everyone for a in everyone if h != a]
                rng.shuffle(pairings)
                for k, (home, away) in enumerate(pairings):
                    day = date(year, 2, 1) + timedelta(days=5 * k)
                    played = day < AS_AT
                    venue = f"{club}-v{rng.randrange(3)}" if home in own else None
                    fixture_id = f"{division}-f{k:03d}"
                    fixtures.append((fixture_id, club, division, home, away, venue, _iso(day, 9 + (k % 4)), f"Round {k // 4 + 1}",
                                     "complete" if played else "scheduled",
                                     rng.randint(0, 5) if played else None, rng.randint(0, 5) if played else None,
                                     "confirmed", "approved", 1))
                    if s == VIEWER_SEASON and d == 0 and club == VIEWER_CLUB and home in own[:2] and not played:
                        roster.append((fixture_id, VIEWER, "Viewer", rng.choice(["in", "out", "pending"]), None))

    counts = {
        "organizations": len(orgs),
        "club_memberships": len(memberships),
        "seasons": len(seasons),
        "divisions": len(divisions),
        "venues": len(venues),
        "external_clubs": len(externals),
        "teams": len(teams),
        "team_players": len(players),
        "fixtures": len(fixtures),
        "fixture_roster": len(roster),
    }
    db.executemany("INSERT INTO organizations(id,name,slug,logo_url,created_at,created_by) VALUES(?,?,?,?,?,?)", orgs)
    db.executemany("INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES(?,?,?,?,?,?,?)", memberships)
    db.executemany("INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES(?,?,?,?,?,?,?)", seasons)
    db.executemany("INSERT INTO divisions(id,season_id,name,format,created_at) VALUES(?,?,?,?,?)", divisions)
    db.executemany("INSERT INTO venues(id,org_id,name,address,map_url,notes,created_at) VALUES(?,?,?,?,?,?,?)", venues)
    db.executemany("INSERT INTO external_clubs(id,org_id,canonical_name,normalized_name,home_venue_id,created_at) VALUES(?,?,?,?,?,?)", externals)
    db.executemany("INSERT INTO teams(id,org_id,division_id,name,colour,external_club_id,is_external,created_at) VALUES(?,?,?,?,?,?,?,?)", teams)
    db.executemany("INSERT INTO team_players(team_id,user_id,display_name,is_active) VALUES(?,?,?,?)", players)
    db.executemany("INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,venue_id,starts_at,round_label,status,home_score,away_score,time_status,review_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", fixtures)
    db.executemany("INSERT INTO fixture_roster(fixture_id,user_id,display_name,availability,confirmed_at) VALUES(?,?,?,?,?)", roster)
    db.commit()
    return counts
