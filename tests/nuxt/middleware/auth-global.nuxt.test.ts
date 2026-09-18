import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { RouteLocationNormalized } from 'vue-router'
import authMiddleware from '../../../app/middleware/auth.global'

const { navigateToMock } = vi.hoisted(() => ({ navigateToMock: vi.fn((to: string) => to) }))

mockNuxtImport('navigateTo', () => navigateToMock)

function route(path: string, query: Record<string, string> = {}): RouteLocationNormalized {
  const search = new URLSearchParams(query).toString()
  return { path, query, fullPath: search ? `${path}?${search}` : path, meta: {} } as unknown as RouteLocationNormalized
}

function run(to: RouteLocationNormalized) {
  return (authMiddleware as unknown as (to: RouteLocationNormalized, from: RouteLocationNormalized) => unknown)(to, to)
}

describe('auth.global middleware', () => {
  beforeEach(() => {
    navigateToMock.mockClear()
    useState('auth').value = {
      user: { id: 'user-1', email: 'invitee@example.com', avatarUrl: null, provider: 'email', displayName: null, theme: 'system' },
      loading: false,
    }
  })

  it('sends a signed-in invitee from the callback to the invited workspace', async () => {
    await run(route('/auth/callback', { workspace: 'lanista-software' }))

    expect(navigateToMock).toHaveBeenCalledWith('/w/lanista-software')
  })

  it('ignores a workspace param that is not a slug', async () => {
    await run(route('/auth/callback', { workspace: '../settings' }))

    expect(navigateToMock).toHaveBeenCalledWith('/')
  })

  it('keeps honoring an internal redirect target', async () => {
    await run(route('/auth/callback', { redirect: '/w/acme/projects/p1' }))

    expect(navigateToMock).toHaveBeenCalledWith('/w/acme/projects/p1')
  })
})
