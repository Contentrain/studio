import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadSessionModule() {
  return import('../../server/utils/session')
}

describe('server session utilities', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns null when the encrypted session does not contain a user id', async () => {
    const session = {
      data: {},
      update: vi.fn(),
      clear: vi.fn(),
    }

    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      sessionSecret: 'x'.repeat(32),
    }))
    vi.stubGlobal('useSession', vi.fn().mockResolvedValue(session))

    const { getServerSession } = await loadSessionModule()

    await expect(getServerSession({} as never)).resolves.toBeNull()
  })

  it('stores and clears the encrypted server session through h3 useSession', async () => {
    const session = {
      data: {},
      update: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    }
    const useSession = vi.fn().mockResolvedValue(session)

    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      sessionSecret: 'x'.repeat(32),
    }))
    vi.stubGlobal('useSession', useSession)

    const { setServerSession, clearServerSession } = await loadSessionModule()

    await setServerSession({} as never, {
      userId: 'user-1',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 123,
    })
    await clearServerSession({} as never)

    expect(useSession).toHaveBeenCalledTimes(2)
    expect(session.update).toHaveBeenCalledWith({
      userId: 'user-1',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 123,
    })
    expect(session.clear).toHaveBeenCalled()
  })

  it('stores and validates one-time auth state tokens', async () => {
    const session = {
      data: {} as { state?: string, createdAt?: number },
      update: vi.fn(async (next: { state: string, createdAt: number }) => {
        session.data = next
      }),
      clear: vi.fn(async () => {}),
    }

    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      sessionSecret: 'x'.repeat(32),
    }))
    vi.stubGlobal('useSession', vi.fn().mockResolvedValue(session))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T10:00:00.000Z'))

    const { setAuthState, validateAuthState } = await loadSessionModule()

    await setAuthState({} as never, 'oauth-state')
    await expect(validateAuthState({} as never, 'oauth-state')).resolves.toBe(true)
    expect(session.clear).toHaveBeenCalled()
  })

  it('rejects missing or expired auth state values', async () => {
    const session = {
      data: {
        state: 'stale-state',
        createdAt: Date.now() - (11 * 60 * 1000),
      },
      update: vi.fn(),
      clear: vi.fn(async () => {}),
    }

    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      sessionSecret: 'x'.repeat(32),
    }))
    vi.stubGlobal('useSession', vi.fn().mockResolvedValue(session))

    const { validateAuthState, getServerSession } = await loadSessionModule()

    await expect(validateAuthState({} as never, 'wrong-state')).resolves.toBe(false)

    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      sessionSecret: 'short-secret',
    }))

    await expect(getServerSession({} as never)).rejects.toThrow(
      'NUXT_SESSION_SECRET must be at least 32 characters',
    )
  })
})
