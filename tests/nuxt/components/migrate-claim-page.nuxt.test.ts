import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ClaimPage from '../../../app/pages/migrate/claim.vue'

const routeQuery = vi.hoisted(() => ({ value: {} as Record<string, string> }))
mockNuxtImport('useRoute', () => () => ({ query: routeQuery.value }))
const navigate = vi.hoisted(() => vi.fn())
mockNuxtImport('navigateTo', () => navigate)

const grantView = (over: Record<string, unknown> = {}) => ({
  id: 'grant-1', kind: 'trial', plan: 'pro', trialDays: 60, repo: { owner: 'acme', name: 'blog' },
  email: 'owner@example.com', workspaceId: null, state: 'claimed', ...over,
})
const bundleView = (over: Record<string, unknown> = {}) => grantView({ kind: 'bundle', trialDays: null, workspaceId: 'ws-1', state: 'redeemed', ...over })

/** The claim answers with `claim`, or fails the way the API does (`data` is the response body, its own `data` the error code). */
interface ApiError { statusCode: number, message: string, code: string, settingsUrl?: string }
/** `connect`: what the connect-project call answers, or the error it fails with. */
function stubFetch(claim: Record<string, unknown> | { error: ApiError }, connect?: Record<string, unknown> | { error: ApiError }) {
  const fail = (error: ApiError) => Object.assign(new Error(error.message), { statusCode: error.statusCode, data: { statusCode: error.statusCode, message: error.message, data: { code: error.code, settingsUrl: error.settingsUrl } } })
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/connect-project')) {
      const error = (connect as { error?: ApiError } | undefined)?.error
      if (error) throw fail(error)
      return connect
    }
    if (url === '/api/migrate/claim') {
      const error = (claim as { error?: ApiError }).error
      if (error) throw Object.assign(new Error(error.message), { statusCode: error.statusCode, data: { statusCode: error.statusCode, message: error.message, data: { code: error.code } } })
      return claim
    }
    return []
  })
  vi.stubGlobal('$fetch', fetcher)
  return fetcher
}

async function mount() {
  routeQuery.value = { token: 'signed.token' }
  const wrapper = await mountSuspended(ClaimPage)
  await flushPromises()
  return wrapper
}

afterEach(() => {
  vi.unstubAllGlobals()
  navigate.mockReset()
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

  describe('connecting the delivered repository', () => {
    const noProject = { grant: bundleView(), destination: { workspaceSlug: 'acme', projectId: null }, comments: null }
    const running = { ...noProject, bundle: { planState: 'active', workspaceSlug: 'acme', periodEndsAt: null } }
    const click = async (wrapper: Awaited<ReturnType<typeof mount>>) => {
      await wrapper.find('[data-testid="claim-connect"]').trigger('click')
      await flushPromises()
    }

    it('plan running, repo not a project yet: Connect, and one click opens the new project', async () => {
      const fetcher = stubFetch(running, { projectId: 'proj-9', workspaceSlug: 'acme', created: true })
      const wrapper = await mount()

      expect(wrapper.find('[data-testid="claim-connect"]').text()).toBe('Connect acme/blog')
      expect(wrapper.find('[data-testid="claim-open-project"]').exists()).toBe(false)
      await click(wrapper)
      expect(fetcher).toHaveBeenCalledWith('/api/migrate/grants/grant-1/connect-project', { method: 'POST' })
      expect(navigate).toHaveBeenCalledWith('/w/acme/projects/proj-9')
    })

    it('plan ended: no Connect, only Choose a plan', async () => {
      stubFetch({ ...noProject, bundle: { planState: 'ended', workspaceSlug: 'acme', periodEndsAt: null } })
      const wrapper = await mount()

      expect(wrapper.find('[data-testid="claim-connect"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="claim-bundle-billing"]').exists()).toBe(true)
    })

    it('the project is already there: Open the site, no Connect', async () => {
      stubFetch({ ...running, destination: { workspaceSlug: 'acme', projectId: 'proj-1' } })
      const wrapper = await mount()
      expect(wrapper.find('[data-testid="claim-connect"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="claim-open-project"]').exists()).toBe(true)
    })

    it.each([
      ['no_installation', 'claim-connect-install', 'Install Studio’s GitHub App'],
      ['repo_not_accessible', 'claim-connect-settings', 'Open the app’s settings on GitHub'],
      ['migration_not_merged', 'claim-connect-retry', 'Check again'],
      ['plan_locked', 'claim-connect-billing', 'Choose a plan'],
    ])('%s: its message and its own next step', async (code, testid, label) => {
      stubFetch(running, { error: { statusCode: 409, message: `message for ${code}`, code, settingsUrl: 'https://github.com/settings/installations/4242' } })
      const wrapper = await mount()
      await click(wrapper)

      const box = wrapper.find('[data-testid="claim-connect-error"]')
      expect(box.attributes('data-code')).toBe(code)
      expect(box.text()).toContain(`message for ${code}`)
      expect(box.find(`[data-testid="${testid}"]`).text()).toContain(label)
      expect(navigate).not.toHaveBeenCalledWith(expect.stringContaining('/projects/'))
    })

    it('repo_not_accessible links straight to the installation\'s settings, and checking again tries the connect again', async () => {
      const fetcher = stubFetch(running, { error: { statusCode: 409, message: 'no access', code: 'repo_not_accessible', settingsUrl: 'https://github.com/settings/installations/4242' } })
      const wrapper = await mount()
      await click(wrapper)

      expect(wrapper.find('[data-testid="claim-connect-settings"]').attributes('href')).toBe('https://github.com/settings/installations/4242')
      await wrapper.find('[data-testid="claim-connect-retry"]').trigger('click')
      await flushPromises()
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/connect-project'))).toHaveLength(2)
    })

    it('a plan that stopped running: the screen then shows it as ended', async () => {
      stubFetch(running, { error: { statusCode: 409, message: 'locked', code: 'plan_locked' } })
      const wrapper = await mount()
      await click(wrapper)
      expect(wrapper.find('[data-testid="claim-bundle-plan"]').attributes('data-plan-state')).toBe('ended')
      expect(wrapper.find('[data-testid="claim-connect"]').exists()).toBe(false)
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
      [{ statusCode: 409, message: 'Claimed by another Studio account.', code: 'claim_taken' }, 'Sign in to Studio with the account that claimed it'],
      [{ statusCode: 410, message: 'This link has expired.', code: 'claim_expired' }, 'Open Studio from your migration'],
      [{ statusCode: 400, message: 'This link is not valid.', code: 'claim_invalid' }, 'Open Studio from your migration'],
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
