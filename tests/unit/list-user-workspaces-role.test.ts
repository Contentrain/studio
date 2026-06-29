import { beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the membership-query filters so we can assert it is scoped to the
// caller's own rows.
const { membershipEqSpy } = vi.hoisted(() => ({ membershipEqSpy: vi.fn() }))

// The user (RLS) client. `select('workspace_id, role')` returns a builder whose
// `.eq('user_id', X)` records the filter and resolves to ONLY the caller's row.
// This mirrors a correct query; if production drops the `.eq('user_id', ...)`,
// the spy assertion below fails.
function makeUserClient() {
  return {
    from: () => ({
      select: () => ({
        eq: (col: string, val: string) => {
          membershipEqSpy(col, val)
          return Promise.resolve({
            // Caller is the OWNER of ws-1. The owner-manage RLS policy would
            // expose co-members too, but a user_id-scoped query returns just
            // this row — so the role must resolve to 'owner', never a member.
            data: [{ workspace_id: 'ws-1', role: 'owner' }],
            error: null,
          })
        },
      }),
    }),
  }
}

function makeAdminClient() {
  return {
    from: (table: string) => {
      if (table === 'workspaces') {
        return {
          select: () => ({
            in: () => ({
              order: () => Promise.resolve({ data: [{ id: 'ws-1', slug: 'lanista', owner_id: 'user-1' }], error: null }),
            }),
            eq: () => ({
              order: () => Promise.resolve({ data: [{ id: 'ws-1', slug: 'lanista', owner_id: 'user-1' }], error: null }),
            }),
          }),
        }
      }
      return {}
    },
  }
}

vi.mock('../../server/providers/supabase-db/helpers', () => ({
  getUser: () => makeUserClient(),
  getAdmin: () => makeAdminClient(),
  // Keep payment enrichment a no-op so the test stays focused on role mapping.
  attachActivePaymentAccounts: (rows: Record<string, unknown>[]) =>
    Promise.resolve(rows.map(r => ({ ...r, payment_account: null }))),
  attachActivePaymentAccount: (r: unknown) => Promise.resolve(r),
  fetchWorkspaceById: vi.fn(),
  requireRole: vi.fn(),
  toDatabaseRow: (r: unknown) => r,
}))

/**
 * Regression: a workspace OWNER who invited a member lost owner/admin access.
 *
 * listUserWorkspaces relied on RLS to scope `workspace_members` to the caller,
 * but the `wm_owner_manage` policy lets an owner SELECT *every* member row of
 * workspaces they own. With ≥2 members, the membership query returned multiple
 * rows and `Object.fromEntries` collapsed them to the last role — so the owner
 * resolved to the invited member's role and the settings tabs / billing /
 * implicit project access vanished. The query must filter to the caller's row.
 */
describe('listUserWorkspaces role resolution', () => {
  beforeEach(() => {
    membershipEqSpy.mockReset()
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => new Error(input.message))
  })

  it('scopes the membership query to the caller and resolves the caller\'s own role', async () => {
    const { workspaceMethods } = await import('../../server/providers/supabase-db/workspaces')

    const result = await workspaceMethods().listUserWorkspaces('token-abc', 'user-1') as Array<{
      id: string
      workspace_members: Array<{ role: string }>
    }>

    // The membership query must be filtered to the caller's own rows.
    expect(membershipEqSpy).toHaveBeenCalledWith('user_id', 'user-1')

    // And the resolved role is the caller's own (owner), not a co-member's.
    const ws = result.find(w => w.id === 'ws-1')
    expect(ws?.workspace_members[0]?.role).toBe('owner')
  })
})
