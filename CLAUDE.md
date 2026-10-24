# tennis-clubs (Pro)

A Pro app on ProAppStore.

- Subdomain: `tennis-clubs.proappstore.online`
- Dev: `pnpm install && pnpm dev`
- Build: `pnpm build` (runs platform compliance check via prebuild)
- Deploy: `git push origin main` (auto-deploys via GitHub Actions → R2)

For platform conventions, read the AI Agent Guide:
https://proappstore.online/skills.md

## SDK

This app uses `@proappstore/sdk`. Available modules:

**Core:**
- `app.auth` — GitHub OAuth sign-in (SSO across all apps)
- `app.kv` — per-user storage (10MB, 100 keys)
- `app.counters` — atomic shared counters
- `app.rooms` — real-time WebSocket rooms
- `app.proxy` — secret-injecting API proxy
- `app.roles` — app-level RBAC
- `app.email` — transactional email (100/day)
- `app.webhooks` — outbound webhook management

**Data & storage:**
- `app.db` — per-app D1 SQL database (query, execute, batch, migrate)
- `app.storage` — file uploads to R2 (private + public URLs)

**Services:**
- `app.subscription` — Stripe checkout + portal + entitlements
- `app.license` — license key generation + validation
- `app.maps` — geocoding, routing, embeds (OpenStreetMap, no API key needed)
- `app.notifications` — Web Push (subscribe, send, broadcast)
- `app.sms` — SMS via Twilio
- `app.ai` — Workers AI (text generation, chat, embeddings)
- `app.usage` — usage tracking for payout calculations

Types: `import type { User, QueryResult, ExecuteResult } from '@proappstore/sdk'`
Hooks: `import { useProAuth, useTheme } from '@proappstore/sdk/hooks'`
UI: `import { ProShell, Avatar, ProBadge } from '@proappstore/sdk/ui'`

## Database

All database operations require the user to be signed in. There is no anonymous/public read access.

### Schema: `migrations.json` (canonical, applied at deploy time)

The repo's `migrations.json` at the root is the source of truth for this app's D1
schema. The deploy workflow applies it **before** the new frontend uploads and
**before** `mcp.json` actions register — so your registered actions can never
reference a column that isn't there yet. This is what keeps schema and code from
drifting (the failure that 500'd users when a migration only ran the first time an
owner opened the app).

```jsonc
// migrations.json — one entry per migration, applied in order, tracked by name.
{
  "migrations": [
    { "name": "0001_init", "sql": "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, user_id TEXT, title TEXT NOT NULL, status TEXT, created_at INTEGER NOT NULL)" }
  ]
}
```

**Rules for `migrations.json` (enforced by the platform on deploy):**
- **Additive only** — `CREATE TABLE/INDEX/VIEW/TRIGGER`, `ALTER TABLE … ADD COLUMN`,
  `INSERT INTO`. Destructive statements (`DROP`, `RENAME`, `DELETE`, `UPDATE`, `PRAGMA`)
  are **rejected** — the deploy fails. Evolve schema by adding columns/tables, never
  by dropping (expand/contract). Keep new columns nullable or defaulted so existing
  rows stay valid and old code keeps working. `ALTER TABLE ... ADD COLUMN ... NOT NULL`
  without a non-null `DEFAULT` is also rejected; add a nullable/defaulted column first, deploy
  compatible code, then tighten/contract in a later release if still needed.
- **Never edit an already-applied migration** — add a new one (`0002_…`, `0003_…`).
  Applied names are tracked, so re-deploys are idempotent (already-applied ones skip).
- Whatever columns your `mcp.json` actions read/write must exist in `migrations.json`.

Expand/contract example for a future change:

```jsonc
{
  "name": "0002_add_priority",
  "sql": "ALTER TABLE items ADD COLUMN priority TEXT DEFAULT 'normal'"
}
```

Deploy code that can read existing rows with the defaulted/nullable column. Do not
rename/drop/tighten the old shape until a later contract release, after no deployed
code depends on it.

The in-browser `app.db.migrate([...])` below still works for local iteration, but the
committed `migrations.json` is authoritative — it runs on every deploy, for everyone,
before any dependent code goes live.

```ts
// Schema migrations (run lazily, tracked by name) — mirrors migrations.json
await app.db.migrate([
  { name: '0001_init', sql: 'CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, user_id TEXT, title TEXT NOT NULL, status TEXT, created_at INTEGER NOT NULL)' },
])

// Queries
const { rows } = await app.db.query<MyType>('SELECT * FROM items WHERE id = ?', [id])
const { meta } = await app.db.execute('INSERT INTO items (id, title, created_at) VALUES (?,?,?)', [id, title, Date.now()])
await app.db.batch([{ sql: '...', params: [...] }, { sql: '...', params: [...] }])

// Multi-tenant helpers (auto-injects tenant_id on all operations)
const tx = app.db.tenant('workspace-id')
await tx.insert('items', { id, title })
const all = await tx.findMany('items')
```

## Auth

```ts
app.auth.signIn()         // GitHub OAuth (default)
app.auth.signIn('google') // Google OAuth
app.auth.signOut()
app.auth.user             // User | null (id, login, avatarUrl, dateOfBirth)

// React hook
const { user, loading, signIn, signOut } = useProAuth(app)
```

## Config & secrets

- Never commit `.env.production` (compliance check fails).
- Public identifiers: set as GitHub repo Variables (`VITE_*` prefix).
- API keys that cost money: use `app.proxy.fetch()`.
- Local dev: use `.env.local` (gitignored).

## CI runner rules

- **Public repos always build on GitHub-hosted runners** (`ubuntu-latest`, unlimited free
  minutes) and must **never** use self-hosted runners. The router returns `["ubuntu-latest"]`
  unless `github.event.repository.private` is `true`, and for a public repo it runs no billing
  check and reads no secret.
- **Private repos go through the billing-aware router.** It checks the org's included Actions
  minutes with the repo-level secret `RUNNER_BILLING_TOKEN`. GitHub-hosted runners first;
  self-hosted `pags` runners only once the included minutes are exhausted (or when the check
  fails, including when the secret is missing).
- **No org-level secrets, ever.** On the free GitHub plan, org secrets are readable by public
  repos. The billing token is a repo-level secret on private repos only, never an org secret.
- **The self-hosted runner group stays private-only.** Never allow public repositories on it.
- **Router reference:** `ProAgentStore/runner-router/.github/workflows/router.yml@v1`, not
  `serge-ivo/runner-router`.

How the workflows follow this: every workflow starts with a `router` job calling
`ProAgentStore/runner-router/.github/workflows/router.yml@v1`, and every other job declares
`needs: router` and `runs-on: ${{ fromJSON(needs.router.outputs.runner) }}`. Never hard-code a
runner label (`ubuntu-latest`, `self-hosted`, anything else) on a job, and never add a job that
skips the router.

## Delivery

- Push directly to `main` (`git push origin main`, which also deploys). Never open a pull request or create a new branch for delivery work, never force-push, and never delete branches left behind by earlier work.
- Let the pre-push hook finish; do not bypass it. Commit with the owner's noreply identity and no co-author trailers.
- The same rules are in `AGENTS.md`.
