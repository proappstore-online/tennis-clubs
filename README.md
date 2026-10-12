# template-app

The app template used by [`pas create`](https://docs.proappstore.online/) to scaffold new Pro apps for [ProAppStore](https://proappstore.online).

You almost certainly want to use the CLI, not clone this directly:

```bash
npm i -g @proappstore/cli
pas create my-app
```

The CLI clones this template, replaces every `tennis-clubs` placeholder with your app id, runs `pnpm install`, initializes git, and makes the first commit — the result is a runnable app you can `pnpm dev` immediately.

## What's in here

- `web/` — Vite + React + TypeScript app, ESM-only, Tailwind 4 via CSS variables.
- `web/src/App.tsx` — Starter component with `initPro()` + `useProAuth()`.
- `web/src/index.css` — Platform design system (Manrope + Fraunces fonts, full light/dark theme tokens).
- `web/index.html` — PWA and link-preview meta tags, font preloading, analytics script.
- `web/public/icon-192.png` and `web/public/icon-512.png` — browser and install icons.
- `web/public/og-image.png` — 1200x630 shared-link preview image for `https://tennis-clubs.proappstore.online`.
- `package.json` — pnpm workspace, `dev` / `build` / `typecheck` scripts. `prebuild` runs platform compliance check.
- `.github/workflows/` — deploy (CF Pages), compliance (MIT + brand + PWA), CI (typecheck).
- `.gitignore` — excludes node_modules, dist, .env files.

## Club administration and team invites

`/admin` is the club setup screen. A signed-in user with no club membership can create their first club and becomes its first club administrator. The creator identity is recorded with the club, and the action layer only allows that same account to bootstrap the initial admin membership. Existing members cannot use first-club creation to gain another club or elevated access. Club administrators and managers can then create seasons, divisions, venues and teams. Those writes are registered actions whose SQL checks the caller's active membership and role in the same club.

Team member onboarding uses PAS delegated group invites. A PAS app team administrator must configure the `manager` data role to invite the `player` role, assign the PAS app role `manager` to each club manager, and grant each manager invite administration for each group named `team:<team-id>`. The app cannot grant its own PAS team or invite administration permissions. After the invitee redeems the one-use PAS invite, the app consumes the private claim token from its metadata to activate that team membership. If delegated invite setup is missing, invite creation fails closed and the manager sees an error.

The `team_memberships` table is the app's team scoped membership record. Pending rows contain an invite token but no user id; accepted rows contain a user id and no token. Fixture reads match the caller against an accepted team membership or the existing `team_players` relation. Player fixture queries never select contact details.

## Sign-in and membership roles

Sign-in uses the ProAppStore SDK's platform-owned identity service. Comps starts Google OAuth with `app.auth.signIn('google')`; the platform returns a verified PAS user id and the app does not store Google credentials or PAS tokens. The signed-in PAS user id is the identity key for `club_memberships.user_id` and accepted `team_memberships.user_id` rows. A user may have different roles in different clubs; the active club membership's `role` controls club administration actions (`admin` and `manager`), while accepted team membership controls player fixture visibility and own availability. Club membership does not grant access to unrelated teams or clubs. Every registered data action requires authentication, and writes check the caller's identity and role in SQL or the PAS app role policy.

On first sign-in, a user with no club membership can create their first club from Club setup. Existing members without manager access are directed to request access from a club administrator. Club managers add people through PAS team invites; an invite becomes an app membership only after the signed-in invitee accepts it. PAS app administrators must configure the delegated invite roles/groups described above. Sign-out returns the UI to the signed-out Google entry point and hides the authenticated Comps view.

### Local and test setup

There is no app-specific `.env` file or Google client secret in this repository. The SDK uses the PAS-hosted Google OAuth flow and the standard PAS app configuration (`appId: 'tennis-clubs'`); OAuth credentials and redirect handling belong to the platform. For local development, install dependencies with `pnpm install` and run `pnpm dev`. A deployed PAS app must have Google sign-in enabled in its platform configuration and the matching app origin/redirect registered there. Authorization tests use the declared migrations and `mcp.json` action SQL with SQLite; they do not need Google credentials or live accounts.

### Public snapshot push guard

The checked-in pre-push hook runs `scripts/check-public-snapshot.py` before a push. Enable it in this clone with `git config --local core.hooksPath .githooks`. The checker reviews tracked files and commit author/committer identities and trailers. CI runs the same checker as an additional review gate.

## MCP contract

The club administrative integration surface is documented in `docs/mcp-contract.md`, generated from `mcp.json` by `python3 scripts/render_mcp_catalog.py`. It covers roles, errors, idempotency, pagination, versioning, audit and redaction for every action.

## Scaffolding manually

If you really want to scaffold by hand:

```bash
cp -r ~/dev/stores/pas/templates/template-app my-app
cd my-app
find . -type f \( -name "*.json" -o -name "*.tsx" -o -name "*.ts" -o -name "*.html" -o -name "*.md" -o -name "*.yaml" \) \
  -not -path "*/node_modules/*" -exec sed -i '' "s/tennis-clubs/my-app/g" {} \;
rm -rf .git && git init
pnpm install && pnpm dev
```

## License

MIT.
