export type ScoredFixture = { status: string; home_score: number | null; away_score: number | null; home_team_name: string; away_team_name: string }

// Only a completed fixture with both overall scores recorded shows a result; anything else shows nothing.
export function completedScoreLabel(fixture: ScoredFixture): string | null {
  if (fixture.status !== 'complete' || fixture.home_score == null || fixture.away_score == null) return null
  return `${fixture.home_team_name} ${fixture.home_score} – ${fixture.away_score} ${fixture.away_team_name}`
}
