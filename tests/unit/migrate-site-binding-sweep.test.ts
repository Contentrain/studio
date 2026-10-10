import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The site-binding sweep (`sweepMigrateSiteBindings`) over a work list in memory: which grants it binds, when it
 * retries, where it stops, and that the ops alarm goes out once per grant. The bind itself is
 * `ensureMigrateSiteBinding` (its own test); here it is a stand-in that records what it was asked to do.
 */

const alarms: Array<Record<string, unknown>> = []
vi.mock('../../server/utils/alert', () => ({ reportMigrateSiteBindingAlarm: (context: Record<string, unknown>) => alarms.push(context) }))

const NOW = new Date('2026-10-10T12:00:00Z')
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000).toISOString()

let rows: Array<Record<string, unknown>>
let alerted: Set<string>
let outcome: (row: Record<string, unknown>) => { state: string, attempts?: number, code?: string } | null
const bound: string[] = []

const grant = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: 'bundle', workspace_id: 'ws-1', repo_owner: 'ABB65', repo_name: id, project_id: `proj-${id}`, project_default_branch: 'main',
  site_binding_state: null, site_binding_attempts: 0, site_binding_next_at: null, site_binding_alerted_at: null, site_binding_detail: null, ...over,
})

const db = {
  listMigrateSiteBindingWork: vi.fn(async (limit: number, _max: number) => rows.slice(0, limit)),
  markMigrateSiteBindingAlerted: vi.fn(async (id: string) => {
    if (alerted.has(id)) return false
    alerted.add(id)
    return true
  }),
  getWorkspaceById: vi.fn(async (id: string) => ({ id, type: 'primary', plan: 'pro', github_installation_id: 7 })),
  setMigrateGrantSiteBinding: vi.fn(),
  getProjectById: vi.fn(),
  getActivePaymentAccount: vi.fn(),
}

async function sweep() {
  const { sweepMigrateSiteBindings } = await import('../../server/utils/migrate-site-binding-run')
  return sweepMigrateSiteBindings({
    db: db as never,
    now: () => NOW,
    bind: (async (input: { grant: Record<string, unknown>, projectId: string, defaultBranch?: string }) => {
      bound.push(`${input.grant.id as string}→${input.projectId}@${input.defaultBranch}`)
      return outcome(input.grant)
    }) as never,
  })
}

beforeEach(() => {
  rows = []
  alerted = new Set()
  alarms.length = 0
  bound.length = 0
  outcome = () => ({ state: 'written' })
  db.listMigrateSiteBindingWork.mockClear()
})

describe('sweepMigrateSiteBindings', () => {
  it('binds a connected site never bound, and a failed one whose retry is due; not one still waiting', async () => {
    rows = [
      grant('never'),
      grant('due', { site_binding_state: 'failed', site_binding_attempts: 1, site_binding_next_at: minutes(-1) }),
      grant('later', { site_binding_state: 'failed', site_binding_attempts: 1, site_binding_next_at: minutes(20) }),
    ]
    expect(await sweep()).toEqual({ checked: 3, bound: 2, failed: 0, waiting: 1, alarms: 0 })
    expect(bound).toEqual(['never→proj-never@main', 'due→proj-due@main'])
    // The cap is the list's filter as well as the sweep's.
    expect(db.listMigrateSiteBindingWork).toHaveBeenCalledWith(50, 5)
  })

  it('a conflict is never bound again: one alarm with the ids, the repository, the state and a code; the next pass is silent', async () => {
    rows = [grant('clash', { site_binding_state: 'conflict', site_binding_detail: { found: { projectId: 'other' } } })]
    expect(await sweep()).toMatchObject({ bound: 0, waiting: 1, alarms: 1 })
    expect(bound).toEqual([])
    expect(alarms).toEqual([{ grantId: 'clash', projectId: 'proj-clash', repo: 'ABB65/clash', state: 'conflict', code: 'conflict', attempts: 0 }])
    // Nothing of the file's content rides along.
    expect(JSON.stringify(alarms)).not.toContain('other')

    expect(await sweep()).toMatchObject({ alarms: 0 })
    expect(alarms).toHaveLength(1)
  })

  it('pr_open and written grants are not the sweep\'s: the list hands them over only by mistake, and then nothing is done', async () => {
    rows = [grant('pr', { site_binding_state: 'pr_open' }), grant('ok', { site_binding_state: 'written' })]
    expect(await sweep()).toMatchObject({ bound: 0, waiting: 2, alarms: 0 })
    expect(bound).toEqual([])
  })

  it('the third failure in a row raises the alarm once, with the recorded code; the fourth does not again', async () => {
    rows = [grant('flaky', { site_binding_state: 'failed', site_binding_attempts: 2, site_binding_next_at: minutes(-1) })]
    outcome = () => ({ state: 'failed', attempts: 3, code: 'github_unavailable' })
    expect(await sweep()).toMatchObject({ failed: 1, alarms: 1 })
    expect(alarms).toEqual([{ grantId: 'flaky', projectId: 'proj-flaky', repo: 'ABB65/flaky', state: 'failed', code: 'github_unavailable', attempts: 3 }])

    rows = [grant('flaky', { site_binding_state: 'failed', site_binding_attempts: 3, site_binding_next_at: minutes(-1), site_binding_alerted_at: minutes(-60) })]
    outcome = () => ({ state: 'failed', attempts: 4, code: 'github_unavailable' })
    expect(await sweep()).toMatchObject({ failed: 1, alarms: 0 })
    expect(alarms).toHaveLength(1)
  })

  it('fewer than three failures: retried, no alarm', async () => {
    rows = [grant('once', { site_binding_state: 'failed', site_binding_attempts: 1, site_binding_next_at: minutes(-1) })]
    outcome = () => ({ state: 'failed', attempts: 2, code: 'github_unavailable' })
    expect(await sweep()).toMatchObject({ failed: 1, alarms: 0 })
  })

  it('at the cap it stops trying; a capped failure not alarmed yet (failed on the claim screen) still raises it once', async () => {
    rows = [grant('dead', { site_binding_state: 'failed', site_binding_attempts: 5, site_binding_next_at: null, site_binding_detail: { code: 'merge_conflict' } })]
    expect(await sweep()).toMatchObject({ bound: 0, waiting: 1, alarms: 1 })
    expect(bound).toEqual([])
    expect(alarms[0]).toMatchObject({ state: 'failed', code: 'merge_conflict', attempts: 5 })
  })

  it('a bind that turns up a conflict alarms at once', async () => {
    rows = [grant('found')]
    outcome = () => ({ state: 'conflict' })
    expect(await sweep()).toMatchObject({ waiting: 1, alarms: 1 })
    expect(alarms[0]).toMatchObject({ grantId: 'found', state: 'conflict' })
  })

  it('a workspace without an installation is left waiting, not counted as a failure', async () => {
    rows = [grant('noapp')]
    outcome = () => null
    expect(await sweep()).toMatchObject({ bound: 0, failed: 0, waiting: 1 })
  })
})
