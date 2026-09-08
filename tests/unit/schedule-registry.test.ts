import { describe, expect, it } from 'vitest'
import { planScheduleRows } from '../../server/utils/schedule-registry'

const base = { projectId: 'p-1', workspaceId: 'ws-1', modelId: 'posts', locale: 'en', entryIds: ['a', 'b'] }
const now = new Date('2026-09-03T12:00:00.000Z')

describe('planScheduleRows', () => {
  it('registers future boundaries for every entry and leaves absent keys alone', () => {
    const { upserts, clearKinds } = planScheduleRows({ ...base, schedule: { publish_at: '2026-09-04T09:00:00Z' } }, now)
    expect(clearKinds).toEqual([])
    expect(upserts).toEqual([
      expect.objectContaining({ entry_id: 'a', kind: 'publish', fire_at: '2026-09-04T09:00:00.000Z', workspace_id: 'ws-1' }),
      expect.objectContaining({ entry_id: 'b', kind: 'publish' }),
    ])
  })

  it('clears a boundary that is null, empty, unparsable, or already in the past', () => {
    const { upserts, clearKinds } = planScheduleRows({ ...base, schedule: { publish_at: null, expire_at: '2026-09-01T00:00:00Z' } }, now)
    expect(upserts).toEqual([])
    expect(clearKinds).toEqual(['publish', 'expire'])

    expect(planScheduleRows({ ...base, schedule: { expire_at: 'soon' } }, now).clearKinds).toEqual(['expire'])
  })

  it('handles publish and expire independently', () => {
    const { upserts, clearKinds } = planScheduleRows({ ...base, entryIds: ['a'], schedule: { publish_at: '2026-09-03T13:00:00Z', expire_at: '' } }, now)
    expect(upserts.map(u => u.kind)).toEqual(['publish'])
    expect(clearKinds).toEqual(['expire'])
  })
})
