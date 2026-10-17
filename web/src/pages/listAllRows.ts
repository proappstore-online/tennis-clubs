// Reads every page of a list action. The server returns at most `pageSize` rows per call, so a short page is the last one.
export async function listAllRows<T>(load: (offset: number) => Promise<{ rows?: T[] }>, pageSize = 100): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = (await load(offset)).rows ?? []
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}
