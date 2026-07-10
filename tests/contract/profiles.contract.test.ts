import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { profileMethods } from '../../server/providers/postgres-db/profiles'
import { deleteSeededUser, mintAccessToken, seedUser } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db profiles (contract)', () => {
  const methods = profileMethods()
  let alice: SeededUser
  let bob: SeededUser
  let aliceToken: string
  let bobToken: string

  beforeAll(async () => {
    alice = await seedUser('alice')
    bob = await seedUser('bob')
    aliceToken = await mintAccessToken(alice.userId)
    bobToken = await mintAccessToken(bob.userId)
  })

  afterAll(async () => {
    await deleteSeededUser(alice.userId)
    await deleteSeededUser(bob.userId)
  })

  it('returns the caller\'s own profile with the bootstrap values', async () => {
    const profile = await methods.getProfile(aliceToken, alice.userId)

    expect(profile).not.toBeNull()
    expect(profile!.id).toBe(alice.userId)
    expect(profile!.display_name).toBe('Contract User')
    expect(profile!.email).toBe(alice.email)
    expect(profile!.theme).toBe('system')
    expect(typeof profile!.created_at).toBe('string')
  })

  it('RLS: a foreign profile reads as null', async () => {
    const profile = await methods.getProfile(bobToken, alice.userId)

    expect(profile).toBeNull()
  })

  it('updates the caller\'s own profile and returns the new row', async () => {
    const updated = await methods.updateProfile(aliceToken, alice.userId, {
      display_name: 'Alice Prime',
      theme: 'dark',
    })

    expect(updated.display_name).toBe('Alice Prime')
    expect(updated.theme).toBe('dark')

    const reread = await methods.getProfile(aliceToken, alice.userId)
    expect(reread!.display_name).toBe('Alice Prime')
  })

  it('RLS: updating a foreign profile throws the 500 contract error', async () => {
    await expect(
      methods.updateProfile(bobToken, alice.userId, { display_name: 'Hijacked' }),
    ).rejects.toMatchObject({ statusCode: 500 })

    const untouched = await methods.getProfile(aliceToken, alice.userId)
    expect(untouched!.display_name).toBe('Alice Prime')
  })

  it('rejects a forged/expired access token with 401', async () => {
    const expired = await mintAccessToken(alice.userId, { expired: true })

    await expect(methods.getProfile(expired, alice.userId)).rejects.toMatchObject({ statusCode: 401 })
    await expect(methods.getProfile('not-a-jwt', alice.userId)).rejects.toMatchObject({ statusCode: 401 })
  })
})
