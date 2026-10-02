import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The claim reads the grant's comments export state. While migration 040 is
 * pending that table is missing: only that case reads as "no export" (and is
 * logged with its code); any other database error still surfaces.
 */

const admin = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../server/providers/postgres-db/helpers', () => ({
  getAdmin: () => admin.current,
  throwDbError: (error: unknown) => {
    throw error
  },
}))
vi.mock('../../server/providers/supabase-db/helpers', () => ({ getAdmin: () => admin.current }))

function pgChain(error: unknown) {
  const chain: Record<string, unknown> = {}
  for (const name of ['updateTable', 'set', 'where', 'selectFrom', 'select'])
    chain[name] = () => chain
  chain.execute = () => (error ? Promise.reject(error) : Promise.resolve([]))
  chain.executeTakeFirst = () => (error ? Promise.reject(error) : Promise.resolve(undefined))
  return chain
}

function supabaseChain(error: { code: string, message: string } | null) {
  const chain: Record<string, unknown> = {}
  for (const name of ['from', 'update', 'not', 'lt', 'select', 'eq'])
    chain[name] = () => chain
  chain.maybeSingle = () => Promise.resolve({ data: null, error })
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error })
  return chain
}

describe('getMigrateCommentsExportState — migration 040 pending', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    vi.unstubAllGlobals()
  })

  describe('postgres', () => {
    it('reads a missing table (42P01) as "no export" and logs the code', async () => {
      const { migrateGrantMethods } = await import('../../server/providers/postgres-db/migrate-grants')
      admin.current = pgChain(Object.assign(new Error('relation does not exist'), { code: '42P01' }))
      await expect(migrateGrantMethods().getMigrateCommentsExportState('g-1')).resolves.toBeNull()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('42P01'))
    })

    it('lets every other error through', async () => {
      const { migrateGrantMethods } = await import('../../server/providers/postgres-db/migrate-grants')
      admin.current = pgChain(Object.assign(new Error('connection terminated'), { code: '57P01' }))
      await expect(migrateGrantMethods().getMigrateCommentsExportState('g-1')).rejects.toThrow('connection terminated')
      expect(warn).not.toHaveBeenCalled()
    })
  })

  describe('supabase', () => {
    it.each(['42P01', 'PGRST205'])('reads a missing table (%s) as "no export" and logs the code', async (code) => {
      const { migrateGrantMethods } = await import('../../server/providers/supabase-db/migrate-grants')
      admin.current = supabaseChain({ code, message: 'missing' })
      await expect(migrateGrantMethods().getMigrateCommentsExportState('g-1')).resolves.toBeNull()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(code))
    })

    it('lets every other error through', async () => {
      const { migrateGrantMethods } = await import('../../server/providers/supabase-db/migrate-grants')
      admin.current = supabaseChain({ code: '42501', message: 'permission denied' })
      await expect(migrateGrantMethods().getMigrateCommentsExportState('g-1')).rejects.toMatchObject({ statusCode: 500, message: 'permission denied' })
      expect(warn).not.toHaveBeenCalled()
    })
  })
})
