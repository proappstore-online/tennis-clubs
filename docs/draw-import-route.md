# Competition-draw import route

Issue #1. `POST /.pas/worker/draw/import` imports a structured competition draw for one club in one transaction. The dry run stays available as the `import_competition_draw` action in `mcp.json`, and the route uses the same SQL.

## Request

- **Method:** `POST`. Other methods get 405.
- **Query:** `org=<club id>` (required; an id with unsafe characters gets 404, and a club the caller does not administer gets 403). `dry_run=true` returns the plan and writes nothing.
- **Body:** a draw JSON document with the same shape as the `import_competition_draw` payload (`source_system`, `source_run`, `season`, `divisions`, `venues`, `external_clubs`, `teams`, `fixtures`, `rosters`). The body is limited to 2 MB.

## Authorisation

The platform verifies the signed-in user and passes the caller to the worker. Without a caller the route answers 401. The club's administrator role is checked in SQL, in the dry run and in every apply step, against the requested club. Anyone else gets 403 and nothing is planned or written.

The route does not use a shared bearer key. The worker has no such secret pattern, and a static key would authorise any holder to write to any club, bypassing the membership checks in the role matrix.

## Responses

| HTTP | `status` | Meaning |
| --- | --- | --- |
| 201 | `imported` | Every record was written in one transaction. |
| 200 | `dry_run` | The plan only. `valid` says whether the payload could be imported. |
| 422 | `rejected` | The payload has blocking problems. Nothing was written; `errors` lists them. |
| 500 | `rolled_back` | A step failed part way through. Nothing was written. |
| 403 | `forbidden` | The caller is not an administrator of the club. |
| 400 / 401 / 404 / 405 / 413 | | Malformed JSON, no caller, unknown club, wrong method, or payload too large or empty. |

Every JSON response carries:

- `importer`: the caller's user id.
- `import_time`: when the route handled the request (ISO 8601).
- `source`: `system`, `run`, and `payload_sha256` of the exact bytes received.
- `planned`: counts of what the plan would do (`created`, `updated`, `skipped`, `conflicted`, `failed`).
- `counts`: counts of what was written. Zero unless `status` is `imported`.
- `records`: one entry per planned record, with `entity_type`, `source_key`, `action`, `severity`, `outcome` and `position`.
- `import_run_id`: once a write was attempted.

A successful import also reports `steps`, the number of rows each apply step wrote.

## Privacy

- Roster player names and external opponent aliases are never in a response. Their `source_key` is `null`, and they are identified by `position`.
- The draw records of the import, including roster names, are stored in the database as before. This matches the existing draw import, and access to them is limited to club administrators.
- The source file is not stored. Only its SHA-256 and the source identifiers are recorded.

## Atomicity and idempotency

A valid import runs as one PAS batch: the run record, the twelve `apply_draw_*` steps in order, and the outcome record. A batch is one transaction, so a failure in any step leaves no run, record or provenance behind. Failure causes are not returned to the caller.

Any blocking row in the plan means the import is refused before the batch starts, so validation failures never write.

Reruns are idempotent. Each attempt records its own run, and the apply steps skip records that already match the payload. A rerun of an unchanged payload reports every record as `skipped`.

## Limits

- The report's `counts` describe the plan that the successful batch applied. The route does not compare them with the per-step row counts. `steps` gives those counts for checking.
- The route runs the same dry-run SQL as the MCP action. Changes to that SQL apply to both.

## Tests

`tests/test_draw_import_route.py` runs the worker under Node against a fake PAS binding that executes the real `mcp.json` SQL on `node:sqlite`. Its `batch` is a real transaction, so the atomicity tests check what the database holds. Run it with the existing draw tests:

```
python3 -m unittest test_competition_draw test_draw_import_route -v
```

On a Python build whose SQLite cannot run the draw dry run (SQLite 3.54 in local testing) the draw tests fail for the same reason they fail at `HEAD`. Their result on that machine is not meaningful.
