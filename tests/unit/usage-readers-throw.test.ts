import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * AI-15: a usage reader whose query fails throws. Both providers used to
 * swallow the error and return 0 (Postgres in a catch, Supabase by never
 * reading `error`), and a 0 lets a quota path through: the Conversation API
 * metered a whole plan as overage on it (QA-4), and the per-model form cap
 * admitted every submission.
 */

const db = vi.hoisted(() => ({ fail: false }))

// Postgres (Kysely): every builder method chains; the terminal call rejects.
vi.mock('../../server/providers/postgres-db/helpers', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const chain: Record<string, unknown> = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined
      if (prop === 'executeTakeFirst' || prop === 'execute')
        return async () => {
          if (db.fail) throw new Error('connection reset')
          return undefined
        }
      return () => chain
    },
  })
  return { ...original, getAdmin: () => chain }
})

// Supabase: every builder method chains; awaiting it resolves the { data, count, error } envelope.
vi.mock('../../server/providers/supabase-db/helpers', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const chain: Record<string, unknown> = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(db.fail
          ? { data: null, count: null, error: { message: 'connection reset' } }
          : { data: [{ id: 'p1' }], count: 0, error: null })
      }
      return () => chain
    },
  })
  return { ...original, getAdmin: () => chain }
})

const { usageMethods: pgUsage } = await import('../../server/providers/postgres-db/usage')
const { formMethods: pgForms } = await import('../../server/providers/postgres-db/forms')
const { commentMethods: pgComments } = await import('../../server/providers/postgres-db/comments')
const { projectMethods: pgProjects } = await import('../../server/providers/postgres-db/projects')
const { cdnMethods: pgCdn } = await import('../../server/providers/postgres-db/cdn')
const { usageMethods: sbUsage } = await import('../../server/providers/supabase-db/usage')
const { formMethods: sbForms } = await import('../../server/providers/supabase-db/forms')
const { commentMethods: sbComments } = await import('../../server/providers/supabase-db/comments')
const { projectMethods: sbProjects } = await import('../../server/providers/supabase-db/projects')
const { cdnMethods: sbCdn } = await import('../../server/providers/supabase-db/cdn')

type Reader = () => Promise<unknown>
type Methods = Record<string, (...args: string[]) => Promise<unknown>>
function readers(p: { usage: Methods, forms: Methods, comments: Methods, projects: Methods, cdn: Methods }): Record<string, Reader> {
  return {
    getWorkspaceMonthlyAIUsage: () => p.usage.getWorkspaceMonthlyAIUsage('w1', '2026-09'),
    getWorkspaceMonthlyAPIUsage: () => p.usage.getWorkspaceMonthlyAPIUsage('w1', '2026-09'),
    getWorkspaceMonthlyCDNBandwidth: () => p.usage.getWorkspaceMonthlyCDNBandwidth('w1', '2026-09'),
    countMonthlySubmissions: () => p.forms.countMonthlySubmissions('w1'),
    countMonthlySubmissionsForModel: () => p.forms.countMonthlySubmissionsForModel('w1', 'p1', 'contact'),
    countMonthlyComments: () => p.comments.countMonthlyComments('w1'),
    getProjectMediaStorageSum: () => p.projects.getProjectMediaStorageSum('p1'),
    getMonthlyProjectCDNUsage: () => p.cdn.getMonthlyProjectCDNUsage('p1', '2026-09-01', '2026-09-30'),
  }
}

const providers = {
  'postgres-db': readers({ usage: pgUsage(), forms: pgForms(), comments: pgComments(), projects: pgProjects(), cdn: pgCdn() } as unknown as Parameters<typeof readers>[0]),
  'supabase-db': readers({ usage: sbUsage(), forms: sbForms(), comments: sbComments(), projects: sbProjects(), cdn: sbCdn() } as unknown as Parameters<typeof readers>[0]),
}

describe('usage readers throw on a failed read instead of reporting 0', () => {
  beforeEach(() => {
    db.fail = false
  })

  for (const [provider, list] of Object.entries(providers)) {
    for (const [name, read] of Object.entries(list)) {
      it(`${provider} ${name}`, async () => {
        // A healthy read still answers with a number (or totals).
        await expect(read()).resolves.not.toBeInstanceOf(Error)
        db.fail = true
        await expect(read()).rejects.toBeTruthy()
      })
    }
  }
})
