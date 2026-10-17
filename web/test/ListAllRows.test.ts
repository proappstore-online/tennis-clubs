import { describe, expect, it, vi } from 'vitest'
import { listAllRows } from '../src/pages/listAllRows'

// Synthetic rows served in pages of at most 100, as the list actions do.
const serve = (total: number) => vi.fn(async (offset: number) => ({ rows: Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, i) => offset + i) }))

describe('listAllRows', () => {
  it('reads every page and keeps the order', async () => {
    const load = serve(250)
    const rows = await listAllRows(load)
    expect(rows).toHaveLength(250)
    expect(rows[249]).toBe(249)
    expect(load.mock.calls.map((call) => call[0])).toEqual([0, 100, 200])
  })

  it('asks for one more page when the first is exactly full, so a fixture on the boundary is not missed', async () => {
    const load = serve(100)
    expect(await listAllRows(load)).toHaveLength(100)
    expect(load.mock.calls.map((call) => call[0])).toEqual([0, 100])
  })

  it('returns an empty list when there are no rows', async () => {
    expect(await listAllRows(serve(0))).toEqual([])
  })
})
