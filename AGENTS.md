# Agent instructions

Read `CLAUDE.md` for the app's conventions. The rules below are restated here so that every agent
sees them whichever file it loads.

## CI runner rules

These apply to **every repository in the proappstore-online org**: the template, every app copied
from it, and any repo added later.

- **Public repos always build on GitHub-hosted runners** (`ubuntu-latest`, unlimited free
  minutes) and must **never** use self-hosted runners.
- **Private repos go through the billing-aware router** (`ProAgentStore/runner-router@v1`):
  GitHub-hosted while the org's included Actions minutes remain, self-hosted `pags` runners only
  once they are spent (or when the billing check fails).
- **No org-level secrets, ever.** On the free plan they are readable by public repos.
- **The billing token is a repo-level secret (`RUNNER_BILLING_TOKEN`) on private repos only.**
  Public repos have no billing token.
- **The self-hosted runner group stays private-only.** Never allow public repositories on it.

How the workflows follow this: every workflow starts with a `router` job calling
`ProAgentStore/runner-router/.github/workflows/router.yml@v1`, and every other job declares
`needs: router` and `runs-on: ${{ fromJSON(needs.router.outputs.runner) }}`. On a public repo the
router job itself runs on `ubuntu-latest` and returns `["ubuntu-latest"]` without a billing check
or reading any secret. Never hard-code a runner label (`ubuntu-latest`, `self-hosted`, anything
else) on a job, and never add a job that skips the router.

Background, in plain English: README, "CI" section. Router behaviour and tests:
https://github.com/ProAgentStore/runner-router.
