// A refused read (401 or 403) means the caller is not signed in as a member of these teams; anything else is a plain load failure.
export function fixturesLoadMessage(failure: unknown): string {
  const status = (failure as { status?: unknown } | null)?.status
  if (status === 401 || status === 403) return 'Sign in with the account that belongs to your team to see its fixtures.'
  return 'Fixtures could not be loaded for your teams.'
}
