/**
 * The handoff Contentrain Migrate actually writes (E2 contract test).
 *
 * `MIGRATION_HANDOFF_GOLDEN` (`@contentrain/types`) is the document a Migrate run builds and stamps on delivery,
 * published with the contract itself so the producer and this consumer test the same bytes. Studio's own tests used
 * hand-built handoffs; this one runs the producer's output through the consumer's validate, split and summary.
 */
import { CAPABILITY_KEYS, MIGRATION_CONTRACT_VERSION, MIGRATION_HANDOFF_GOLDEN } from '@contentrain/types'
import { describe, expect, it } from 'vitest'
import {
  enrichMigrationHandoff,
  splitMigrationHandoff,
  summarizeMigrationHandoff,
  validateMigrationHandoff,
} from '../../server/utils/migration-handoff'

const handoff = MIGRATION_HANDOFF_GOLDEN

describe('the handoff Migrate writes, through Studio', () => {
  it('passes Studio validation', () => {
    expect(validateMigrationHandoff(handoff)).toBeNull()
  })

  it('every capability and offer key is one Studio\'s pinned types know', () => {
    const known = new Set<string>(CAPABILITY_KEYS)
    expect(handoff.capabilities.length).toBeGreaterThan(0)
    for (const capability of handoff.capabilities) expect(known.has(capability.key), capability.key).toBe(true)
    for (const offer of handoff.offers ?? []) expect(known.has(offer.capability), offer.capability).toBe(true)
  })

  it('splits into a manifest and no inline comments export (Migrate keeps it out of the repository)', () => {
    const { manifest } = splitMigrationHandoff(handoff, { path: '.contentrain/migrate/handoff.json', ref: 'contentrain' }, JSON.stringify(handoff).length)
    expect(manifest.version).toBe(1)
    expect(manifest.studio_intake?.comments).toEqual({ kind: 'none' })
  })

  it('summarises: the forms and comments capabilities stay runtime work until Studio is bound', () => {
    const summary = summarizeMigrationHandoff({ ...handoff })
    expect(summary.siteUrl).toBe('https://site.test')
    expect(JSON.stringify(summary)).toContain('forms')
  })

  it('a stamped repository is kept; Studio only fills it when missing', () => {
    expect(enrichMigrationHandoff(handoff, { repo_full_name: 'other/repo' }).repository).toEqual({ provider: 'github', owner: 'acme', name: 'site', default_branch: 'main' })
  })

  it('the run and order the handoff was delivered for are read when present, and absent on an older document (unknown, not stale)', () => {
    const summary = summarizeMigrationHandoff({ ...handoff })
    if (handoff.plan_hash) expect(summary.planHash).toBe(handoff.plan_hash)
    if (handoff.order_id) expect(summary.orderId).toBe(handoff.order_id)
    const { plan_hash: _p, order_id: _o, ...older } = handoff
    expect(validateMigrationHandoff(older)).toBeNull()
    expect(summarizeMigrationHandoff({ ...older })).not.toHaveProperty('planHash')
    expect(summarizeMigrationHandoff({ ...older })).not.toHaveProperty('orderId')
    const stamped = { ...handoff, plan_hash: '0123456789abcdef', order_id: `ord_${'a'.repeat(24)}` }
    expect(validateMigrationHandoff(stamped)).toBeNull()
    expect(summarizeMigrationHandoff({ ...stamped })).toMatchObject({ planHash: '0123456789abcdef', orderId: `ord_${'a'.repeat(24)}` })
  })

  it('the contract version is a range: the pinned version and below are read, above is refused', () => {
    expect(validateMigrationHandoff({ ...handoff, version: MIGRATION_CONTRACT_VERSION })).toBeNull()
    expect(validateMigrationHandoff({ ...handoff, version: MIGRATION_CONTRACT_VERSION + 1 })).toEqual({ code: 'unsupported_version', detail: String(MIGRATION_CONTRACT_VERSION + 1) })
    expect(validateMigrationHandoff({ ...handoff, version: 0 })).toEqual({ code: 'unsupported_version', detail: '0' })
    expect(validateMigrationHandoff({ ...handoff, version: 1.5 })).toMatchObject({ code: 'unsupported_version' })
  })
})
