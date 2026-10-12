export type Document = { id: string; title: string; description: string | null; category: string; visibility: string; scope_type: string; scope_id: string | null; team_id: string | null; source_attribution: string; effective_on: string; revision: string | null; expires_on: string | null; status: string; byte_size: number | null }
export type NamedRow = { id: string; name: string }
export type Names = { seasons: Map<string, string>; teams: Map<string, string> }
export type DocumentFilters = { seasonId: string; teamId: string }

export const CATEGORIES = ['guidance', 'behaviour', 'etiquette', 'competition', 'roster', 'other'] as const

export const emptyNames = (): Names => ({ seasons: new Map(), teams: new Map() })

export function namesFrom(seasons: NamedRow[], teams: NamedRow[]): Names {
  return { seasons: new Map(seasons.map((row) => [row.id, row.name])), teams: new Map(teams.map((row) => [row.id, row.name])) }
}

// A team document is scoped to the team in scope_id; team_id is only set for team visibility.
const teamIdOf = (doc: Document) => (doc.scope_type === 'team' ? doc.scope_id : null) ?? doc.team_id

export function applicabilityLabel(doc: Document, names: Names): string {
  const teamId = teamIdOf(doc)
  if (teamId) return `Team: ${names.teams.get(teamId) ?? 'team document'}`
  if (doc.scope_type === 'season') return `Season: ${names.seasons.get(doc.scope_id ?? '') ?? 'season document'}`
  if (doc.scope_type === 'competition') return 'Competition'
  return 'Whole club'
}

// Options come from the documents themselves, so members (who cannot list seasons or teams) still get filters.
export function seasonOptions(docs: Document[], names: Names): NamedRow[] {
  const ids = [...new Set(docs.filter((doc) => doc.scope_type === 'season' && doc.scope_id).map((doc) => doc.scope_id as string))]
  return ids.map((id, index) => ({ id, name: names.seasons.get(id) ?? `Season ${index + 1}` }))
}

export function teamOptions(docs: Document[], names: Names): NamedRow[] {
  const ids = [...new Set(docs.map(teamIdOf).filter((id): id is string => Boolean(id)))]
  return ids.map((id, index) => ({ id, name: names.teams.get(id) ?? `Team ${index + 1}` }))
}

export function filterDocuments(docs: Document[], filters: DocumentFilters): Document[] {
  return docs.filter((doc) => (!filters.seasonId || (doc.scope_type === 'season' && doc.scope_id === filters.seasonId))
    && (!filters.teamId || teamIdOf(doc) === filters.teamId))
}
