/**
 * The handoff Contentrain Migrate actually writes (E2 contract test).
 *
 * `tests/fixtures/migrate-handoff-golden.json` is the document a Migrate run builds and stamps on delivery
 * (copied byte for byte from Contentrain/migrate `packages/delivery/tests/fixtures/studio-golden-handoff.json`,
 * regenerated there with `UPDATE_GOLDEN=1`). Studio's own tests used hand-built handoffs; this one runs the
 * producer's output through the consumer's validate, split and summary, in CI (no env vars needed).
 */
import { CAPABILITY_KEYS, MIGRATION_CONTRACT_VERSION, type MigrationHandoff } from '@contentrain/types'
import { describe, expect, it } from 'vitest'
import golden from '../fixtures/migrate-handoff-golden.json'
import {
  enrichMigrationHandoff,
  splitMigrationHandoff,
  summarizeMigrationHandoff,
  validateMigrationHandoff,
} from '../../server/utils/migration-handoff'

const handoff = golden as unknown as MigrationHandoff

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

  it('the contract version is a range: the pinned version and below are read, above is refused', () => {
    expect(validateMigrationHandoff({ ...handoff, version: MIGRATION_CONTRACT_VERSION })).toBeNull()
    expect(validateMigrationHandoff({ ...handoff, version: MIGRATION_CONTRACT_VERSION + 1 })).toEqual({ code: 'unsupported_version', detail: String(MIGRATION_CONTRACT_VERSION + 1) })
    expect(validateMigrationHandoff({ ...handoff, version: 0 })).toEqual({ code: 'unsupported_version', detail: '0' })
    expect(validateMigrationHandoff({ ...handoff, version: 1.5 })).toMatchObject({ code: 'unsupported_version' })
  })
})
