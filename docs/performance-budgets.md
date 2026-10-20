# Performance budgets

Status: in force for CI. Issue #35 (slice 5 of #26). The machine-readable budgets are in [`performance-budgets.json`](performance-budgets.json); this document explains them. A test checks that the two agree.

## What is budgeted

| Budget | Limit | What it measures |
| --- | --- | --- |
| `list_my_fixtures.upcoming` | 100 ms | The default Fixtures page: the signed-in member's upcoming fixtures, 50 rows. |
| `list_my_fixtures.past` | 500 ms | The Past tab: 50 rows before today. |
| `list_my_fixtures.all` | 400 ms | The All tab: 50 rows across the whole history. |
| `list_club_venues` | 50 ms | The venue directory in Club setup: up to 100 venues for a club. |
| `list_club_teams` | 50 ms | The team directory in Club setup: up to 100 own teams for a club. |
| Bundle, JS | 125 KB gzipped | The app's JavaScript in `web/dist/assets`. The app is one chunk, so this covers every page. |
| Bundle, CSS | 8 KB gzipped | The app's stylesheet in `web/dist/assets`. |

Query budgets are in milliseconds and measure the median of 7 runs after one warm-up run. The seed is `tests/association_seed.py`, which generates the same association each time.

## Page budgets

Issue #30. A page budget limits what a page costs the server in total. The page's cost is the sum of the median latency of the calls it makes, measured on the seeded association by `scripts/check-page-budget.py`.

| Page | Budget | What it covers |
| --- | --- | --- |
| `fixtures` | 100 ms | The Fixtures page for a signed-in member: the upcoming list (`list_my_fixtures`), then one fixture's roster (`list_fixture_roster`). |
| `directory` | 50 ms | The Club setup directory: the club's venues (`list_club_venues`) and its teams (`list_club_teams`). |

Directory search and map search do not exist yet, so there is no page for them. When a search is added it needs its own page entry, with the calls it makes.

`tests/test_page_budgets.py` checks that the page list in the budget file matches the pages the script measures, that every call is an action in the manifest, and that the script exits non-zero when a page is over budget and refuses a malformed budget file. CI runs the Python unit tests, so a page over budget fails the build.

Limits: the page cost is a sum of server calls, measured on SQLite. No browser runs in CI, so rendering time is not in the page budget. The bundle budget above is the only load-time check.

## Measured baseline

Local runs of the seeded association on the development machine (medians, milliseconds):

| Query | Median | Budget |
| --- | --- | --- |
| `list_my_fixtures.upcoming` | about 7 to 18 | 100 |
| `list_my_fixtures.past` | about 170 to 185 | 500 |
| `list_my_fixtures.all` | about 105 to 160 | 400 |
| `list_club_venues` | under 1 | 50 |
| `list_club_teams` | under 1 | 50 |

Bundle at the time the budgets were set: 108 KB gzipped JavaScript, 6.4 KB gzipped CSS.

The budgets are set at roughly three times the local medians. That leaves room for a slower CI runner, and still fails on a real regression.

## The association the budgets are measured against

`tests/association_seed.py` builds the following, deterministically, into an in-memory database with every migration applied:

- 40 clubs, each with 3 seasons, 3 divisions a season and 8 teams a division (4 own teams and 4 external opponents, each external opponent its own external club).
- A double round robin in every division, which gives about 20,000 fixtures in total.
- About 14,000 team player records and about 2,900 teams.
- Synthetic names only. No personal data is used.

`test_seed_is_at_association_scale` fails if the seed produces fewer rows than the `scale` figures in the budgets file, so the budgets cannot pass against a smaller data set.

## How the check runs

- Query budgets: `tests/test_performance_budgets.py` runs in CI with the Python unit tests (`python3 -m unittest discover -s tests`). It fails the test job when a median exceeds its budget. The failure message names the query, the measured median and the budget.
- Bundle budgets: `scripts/check-bundle-budget.py` runs in CI after the web build. It fails the test job when the gzipped JavaScript or CSS exceeds its budget.

## Limits of these numbers

- **The queries run on SQLite, not Cloudflare D1.** D1 is SQLite-compatible, but its latency differs. These budgets detect regressions in query work. They do not promise a production latency.
- **No browser load time is measured.** CI has no browser. The bundle budget is the load-time proxy: it bounds what the browser must download and parse. Real page load and render time need a browser-based check, which is not built yet.
- **No map or directory search exists.** The venue directory is a list, and the map is a link to an external map service. There is nothing to budget for search yet. When a search is added, it needs its own budget and query.
- **`list_my_fixtures` scans every fixture.** The query plan starts with `SCAN f`, because it filters on team membership rather than on `org_id`. The indexes it uses on the membership tables are in place, so the cost is the scan itself. The `past` budget is set to allow for this. Narrowing the scan (for example, by starting from the member's team IDs) would bring the `past` and `all` queries well under budget. That is a change to `mcp.json` SQL, so it is a follow-up, not part of this budget.

## Changing a budget

1. Measure first: run the test and read the median in the failure message.
2. Decide whether the regression is acceptable or the budget was wrong. A budget is raised only with a reason written here.
3. Change `docs/performance-budgets.json` and the matching figure in this document in the same commit. The docs test fails if they differ.
