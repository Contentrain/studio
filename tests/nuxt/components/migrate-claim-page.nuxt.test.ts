import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ClaimPage from '../../../app/pages/migrate/claim.vue'

const routeQuery = vi.hoisted(() => ({ value: {} as Record<string, string> }))
mockNuxtImport('useRoute', () => () => ({ query: routeQuery.value }))

const grantView = (over: Record<string, unknown> = {}) => ({
  id: 'grant-1', kind: 'trial', plan: 'pro', trialDays: 60, repo: { owner: 'acme', name: 'blog' },
  email: 'owner@example.com', workspaceId: null, state: 'claimed', ...over,
})
const bundleView = (over: Record<string, unknown> = {}) => grantView({ kind: 'bundle', trialDays: null, workspaceId: 'ws-1', state: 'redeemed', ...over })

/** The claim answers with `claim`, or fails the way the API does (`data` is the response body, its own `data` the error code). */
interface ApiError { statusCode: number, message: string, code: string }
function stubFetch(claim: Record<string, unknown> | { error: ApiError }) {
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
    if (url === '/api/migrate/claim') {
      const error = (claim as { error?: ApiError }).error
      if (error) throw Object.assign(new Error(error.message), { statusCode: error.statusCode, data: { statusCode: error.statusCode, message: error.message, data: { code: error.code } } })
      return claim
    }
    return []
  }))
}

async function mount() {
  routeQuery.value = { token: 'signed.token' }
  const wrapper = await mountSuspended(ClaimPage)
  await flushPromises()
  return wrapper
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/migrate/claim', () => {
  describe('a bundle grant', () => {
    it('covered order, plan running: no trial or checkout, a way to the project', async () => {
      stubFetch({ grant: bundleView(), destination: { workspaceSlug: 'acme', projectId: 'proj-1' }, bundle: { planState: 'active', workspaceSlug: 'acme', periodEndsAt: null }, comments: null })
      const wrapper = await mount()

      expect(wrapper.find('[data-testid="claim-bundle"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="claim-open-project"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="claim-bundle-plan"]').attributes('data-plan-state')).toBe('active')
      expect(wrapper.find('[data-testid="claim-bundle-billing"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('acme/blog')
      expect(wrapper.text()).not.toContain('$0.00')
      expect(wrapper.text()).not.toContain('trial')
    })

    it('plan ended: says so honestly and points to billing, the project stays reachable', async () => {
      stubFetch({ grant: bundleView(), destination: { workspaceSlug: 'acme', projectId: 'proj-1' }, bundle: { planState: 'ended', workspaceSlug: 'acme', periodEndsAt: null }, comments: null })
      const wrapper = await mount()

      expect(wrapper.find('[data-testid="claim-bundle-plan"]').text()).toBe('Your Studio plan has ended. To continue, choose a plan.')
      expect(wrapper.find('[data-testid="claim-bundle-billing"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="claim-open-project"]').exists()).toBe(true)
    })

    it('plan set to end: says when, calmly, with no extra button', async () => {
      stubFetch({ grant: bundleView(), destination: { workspaceSlug: 'acme', projectId: 'proj-1' }, bundle: { planState: 'ending', workspaceSlug: 'acme', periodEndsAt: Date.parse('2027-01-15T12:00:00Z') / 1000 }, comments: null })
      const wrapper = await mount()

      expect(wrapper.find('[data-testid="claim-bundle-plan"]').text()).toBe('Your plan ends on January 15, 2027.')
      expect(wrapper.find('[data-testid="claim-bundle-billing"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="claim-open-project"]').exists()).toBe(true)
    })

    it('paid bundle whose repository has not reached Studio: the workspace, and never a TypeError on the null repo', async () => {
      stubFetch({ grant: bundleView({ repo: null }), destination: { workspaceSlug: 'acme', projectId: null }, bundle: { planState: 'active', workspaceSlug: 'acme', periodEndsAt: null }, comments: null })
      const wrapper = await mount()

      expect(wrapper.find('[data-testid="claim-error"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="claim-open-workspace"]').exists()).toBe(true)
    })

    it('no destination yet: still a button on', async () => {
      stubFetch({ grant: bundleView({ workspaceId: null, state: 'claimed' }), destination: null, bundle: null, comments: null })
      const wrapper = await mount()
      expect(wrapper.find('[data-testid="claim-open-studio"]').exists()).toBe(true)
    })
  })

  it('a trial grant is unchanged: the included days, the workspace picker and the start button', async () => {
    stubFetch({ grant: grantView(), destination: null, bundle: null, comments: null })
    const wrapper = await mount()

    expect(wrapper.find('[data-testid="claim-bundle"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('60 days of Studio')
    expect(wrapper.text()).toContain('$0.00')
  })

  describe('a refused claim is never a dead end', () => {
    it.each([
      [{ statusCode: 409, message: 'Already claimed elsewhere.', code: 'claim_taken' }, 'Sign in to Studio with the account that claimed it'],
      [{ statusCode: 410, message: 'This link has expired.', code: 'claim_expired' }, 'You can open Studio'],
      [{ statusCode: 400, message: 'This link is not valid.', code: 'claim_invalid' }, 'You can open Studio'],
    ])('%o: the reason, a next step, and a way to reach us', async (error, next) => {
      stubFetch({ error })
      const wrapper = await mount()

      const box = wrapper.find('[data-testid="claim-error"]')
      expect(box.text()).toContain(error.message)
      expect(box.text()).toContain(next)
      expect(wrapper.find('[data-testid="claim-error-open-studio"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="claim-error-support"]').attributes('href')).toMatch(/^mailto:/)
    })
  })
})
