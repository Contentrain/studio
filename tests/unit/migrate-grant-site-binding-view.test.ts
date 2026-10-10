import { describe, expect, it, vi } from 'vitest'
import strings from '../../.contentrain/content/system/ui-strings/en.json'

vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription' }) }))

/** What the claim screen reads of a grant's site binding (049): the state and only what it says, never more. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'grant-1', kind: 'bundle', plan: 'pro', trial_days: null, repo_owner: 'ABB65', repo_name: 'formchickens',
  email: 'ada@example.com', workspace_id: 'ws-1', bound_at: 'x', redeemed_at: 'x', ...over,
})

describe('migrateGrantView: siteBinding', () => {
  it('absent until a binding was tried', async () => {
    const { migrateGrantView } = await import('../../server/utils/migrate-grant')
    expect(migrateGrantView(row())).not.toHaveProperty('siteBinding')
  })

  it('pr_open carries its pull request; partial its form models over the plan and the limit; a conflict shows no values', async () => {
    const { migrateGrantView } = await import('../../server/utils/migrate-grant')
    expect(migrateGrantView(row({ site_binding_state: 'pr_open', site_binding_detail: { path: 'studio.json', prUrl: 'https://github.com/ABB65/formchickens/pull/3' } })).siteBinding)
      .toEqual({ state: 'pr_open', prUrl: 'https://github.com/ABB65/formchickens/pull/3', overLimit: [], limit: null })
    expect(migrateGrantView(row({ site_binding_state: 'partial', site_binding_detail: { overLimit: ['newsletter', 7], limit: 1, formModels: 2 } })).siteBinding)
      .toEqual({ state: 'partial', prUrl: null, overLimit: ['newsletter'], limit: 1 })
    expect(migrateGrantView(row({ site_binding_state: 'conflict', site_binding_detail: { found: { projectId: 'other' }, expected: { projectId: 'proj-1' } } })).siteBinding)
      .toEqual({ state: 'conflict', prUrl: null, overLimit: [], limit: null })
  })

  it('a pull request address that is not https is not passed on as a link', async () => {
    const { migrateGrantView } = await import('../../server/utils/migrate-grant')
    expect(migrateGrantView(row({ site_binding_state: 'pr_open', site_binding_detail: { prUrl: 'javascript:alert(1)' } })).siteBinding?.prUrl).toBeNull()
  })
})

describe('claim-screen copy for the site binding (honest about the rebuild)', () => {
  const dict = strings as Record<string, string>
  it('written and partial say the forms send once the host rebuilds, never that the site is already updated', () => {
    expect(dict['migrate_claim.site_binding_written']).toBe('Your site’s forms and comments send to Studio once your host rebuilds the site: studio.json is in your repository.')
    expect(dict['migrate_claim.site_binding_partial']).toMatch(/^Your site’s forms and comments send to Studio once your host rebuilds the site: studio\.json is in your repository\. /)
    expect(dict['migrate_claim.site_binding_partial']).toContain('{limit}')
    expect(dict['migrate_claim.site_binding_partial']).toContain('{forms}')
    for (const key of Object.keys(dict).filter(k => k.startsWith('migrate_claim.site_binding_')))
      expect(dict[key], key).not.toMatch(/now send|is now updated|is updated/)
  })
})
