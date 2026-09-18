import { describe, expect, it, vi } from 'vitest'
import { defineEventHandler } from 'h3'
import { getServerSession, setServerSession } from '../../server/utils/session'
import { TestCookieJar, withTestServer } from '../helpers/http'

const DAY = 24 * 60 * 60 * 1000
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60

function sessionCookie(response: Response): string {
  return response.headers.getSetCookie().find(c => c.startsWith('contentrain-session=')) ?? ''
}

describe('session cookie lifetime', () => {
  it('restarts the 7-day window on every session write instead of dating it from sign-in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T07:47:55.000Z'))

    const jar = new TestCookieJar()

    await withTestServer({
      routes: [
        {
          path: '/sign-in',
          handler: defineEventHandler(async (event) => {
            await setServerSession(event, { userId: 'user-1', accessToken: 'a1', refreshToken: 'r1', expiresAt: 1 })
            return { ok: true }
          }),
        },
        {
          // What 01.auth does on an expired access token: read, then rewrite.
          path: '/refresh',
          handler: defineEventHandler(async (event) => {
            const current = await getServerSession(event)
            await setServerSession(event, { ...current!, accessToken: 'a2', refreshToken: 'r2' })
            return { userId: current?.userId }
          }),
        },
      ],
    }, async ({ request }) => {
      const signIn = await request('/sign-in')
      jar.absorb(signIn)
      expect(sessionCookie(signIn)).toContain(`Max-Age=${SEVEN_DAYS_SECONDS}`)

      // Six and a half days of active use later, an hourly refresh rewrites the cookie.
      vi.setSystemTime(new Date(Date.parse('2026-09-01T07:47:55.000Z') + 6.5 * DAY))
      const refresh = await request('/refresh', { headers: { cookie: jar.header() } })

      await expect(refresh.json()).resolves.toEqual({ userId: 'user-1' })
      const cookie = sessionCookie(refresh)
      expect(cookie).toContain(`Max-Age=${SEVEN_DAYS_SECONDS}`)
      // No absolute Expires pinned to the original sign-in (2026-09-08).
      expect(cookie).not.toMatch(/Expires=/i)
    })
  })
})
