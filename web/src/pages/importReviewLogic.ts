export type ImportRun = { id: string; org_id: string; kind: 'fixtures' | 'roster'; status: 'saved' | 'rejected'; received_count: number; saved_count: number; rejected_count: number; source_sha256: string | null; blocking_count: number; warning_count: number; acknowledged_count: number; created_at: number }
export type ManagedFixture = { id: string; org_id: string; starts_at: string; time_status: string | null; arrival_at: string | null; source_row: number | null; source_date_raw: string | null; source_time_raw: string | null; source_import_run_id: string | null; round_label: string | null; status: string; home_team_name: string; away_team_name: string; opponent_name: string | null; review_status: ReviewStatus; reviewed_at: number | null; reviewed_by_name: string | null }
export type ReviewStatus = 'needs_review' | 'approved' | 'auto_approved'
export type Club = { id: string; name: string; role: string }

const MANAGER_ROLES = ['admin', 'convenor', 'manager']

export function managerClubs(clubs: Club[]): Club[] {
  return clubs.filter((club) => MANAGER_ROLES.includes(club.role))
}

// Runs arrive newest first, so the first match for each kind is the latest report.
export function latestRun(runs: ImportRun[], kind: ImportRun['kind']): ImportRun | null {
  return runs.find((run) => run.kind === kind) ?? null
}

export function provenanceRows(fixtures: ManagedFixture[], orgId: string, runId: string): ManagedFixture[] {
  return fixtures
    .filter((fixture) => fixture.org_id === orgId && fixture.source_import_run_id === runId)
    .sort((a, b) => (a.source_row ?? 0) - (b.source_row ?? 0))
}

// Estimated and TBC times are not confirmed; members see them with that status.
export function needsConfirmation(timeStatus: string | null): boolean {
  return timeStatus === 'estimated' || timeStatus === 'tbc'
}

// The server computes review_status (see mcp.json list_managed_fixtures); a fixture waits for a manager until approved.
export function awaitingReview(fixture: Pick<ManagedFixture, 'review_status'>): boolean {
  return fixture.review_status === 'needs_review'
}

export function approvalLabel(fixture: Pick<ManagedFixture, 'review_status' | 'reviewed_at' | 'reviewed_by_name'>): string {
  if (fixture.review_status === 'approved' && fixture.reviewed_at !== null) {
    return `Approved by ${fixture.reviewed_by_name ?? 'a manager'} on ${reportDate(fixture.reviewed_at)}`
  }
  return fixture.review_status === 'auto_approved' ? 'Confirmed time, visible to members' : 'Approved'
}

export function fingerprint(sha256: string | null): string {
  return sha256 ? sha256.slice(0, 12) : 'not recorded'
}

export function reportDate(createdAt: number): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(createdAt))
}

export type RunIssue = { source_row: number; severity: 'blocking' | 'warning'; code: string; field: string | null; message: string | null; remediation: string | null }
export const issueSeverityLabel = (severity: RunIssue['severity']) => (severity === 'blocking' ? 'Blocking' : 'Warning')
