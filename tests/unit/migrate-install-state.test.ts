import { SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  looksLikeMigrateInstallState,
  migrateInstallStateKey,
  signMigrateInstallState,
  verifyMigrateInstallState,
} from '../../server/utils/migrate-install-state'

const key = new TextEncoder().encode('k'.repeat(40))
const otherKey = new TextEncoder().encode('o'.repeat(40))
const input = { grantId: 'grant-1', workspaceId: 'ws-1', userId: 'user-1' }

afterEach(() => vi.unstubAllGlobals())

describe('migrate install state', () => {
  it('round-trips the grant, workspace and user, with a single-use id and a short life', async () => {
    const { token, state } = await signMigrateInstallState(input, key)
    expect(await verifyMigrateInstallState(token, key)).toEqual(state)
    expect(state).toMatchObject(input)
    expect(state.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600)
    expect((await signMigrateInstallState(input, key)).state.jti).not.toBe(state.jti)
  })

  it('refuses a token signed with another key, an expired one, a tampered one and a forged algorithm', async () => {
    const { token } = await signMigrateInstallState(input, key)
    expect(await verifyMigrateInstallState(token, otherKey)).toBeNull()

    const old = await signMigrateInstallState(input, key, new Date(Date.now() - 3600_000))
    expect(await verifyMigrateInstallState(old.token, key)).toBeNull()

    const [h, , s] = token.split('.')
    const forgedBody = Buffer.from(JSON.stringify({ grantId: 'grant-2', workspaceId: 'ws-1', userId: 'user-1' })).toString('base64url')
    expect(await verifyMigrateInstallState(`${h}.${forgedBody}.${s}`, key)).toBeNull()

    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`
    expect(await verifyMigrateInstallState(none, key)).toBeNull()
    expect(await verifyMigrateInstallState('not a token', key)).toBeNull()
  })

  it('refuses a token for another audience or without the grant fields', async () => {
    const now = Math.floor(Date.now() / 1000)
    const other = await new SignJWT({ grantId: 'g', workspaceId: 'w', userId: 'u' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer('contentrain-studio').setAudience('someone-else')
      .setJti('j').setIssuedAt(now).setExpirationTime(now + 300).sign(key)
    expect(await verifyMigrateInstallState(other, key)).toBeNull()
    const partial = await new SignJWT({ grantId: 'g' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer('contentrain-studio').setAudience('studio-github-install')
      .setJti('j').setIssuedAt(now).setExpirationTime(now + 300).sign(key)
    expect(await verifyMigrateInstallState(partial, key)).toBeNull()
  })

  it('tells a signed state from a workspace id', async () => {
    const { token } = await signMigrateInstallState(input, key)
    expect(looksLikeMigrateInstallState(token)).toBe(true)
    expect(looksLikeMigrateInstallState('3f2b1c9e-6c7a-4e1f-9d1a-2b3c4d5e6f70')).toBe(false)
    expect(looksLikeMigrateInstallState('workspace-primary')).toBe(false)
    expect(looksLikeMigrateInstallState(undefined)).toBe(false)
    expect(looksLikeMigrateInstallState(['a.b.c'])).toBe(false)
  })

  it('is off without a key, and for one too short to trust', () => {
    const config = (installStateKey: string) => vi.stubGlobal('useRuntimeConfig', () => ({ migrate: { installStateKey } }))
    config('')
    expect(migrateInstallStateKey()).toBeNull()
    config('short')
    expect(migrateInstallStateKey()).toBeNull()
    config(' '.repeat(5) + 'k'.repeat(32) + ' ')
    expect(migrateInstallStateKey()).toEqual(new TextEncoder().encode('k'.repeat(32)))
  })
})
