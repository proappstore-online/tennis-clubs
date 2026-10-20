# Agent instructions

Read `CLAUDE.md` for the app's conventions. The rules below are restated here so that every agent
sees them whichever file it loads.

## CI runner rules

These apply to **every repository in the proappstore-online org**: the template, every app copied
from it, and any repo added later.

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

Background, in plain English: README, "CI" section. Router behaviour and tests:
https://github.com/ProAgentStore/runner-router.
