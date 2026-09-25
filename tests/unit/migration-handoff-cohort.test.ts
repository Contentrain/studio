/**
 * Real Migrate handoffs through the intake — opt-in, the files live outside
 * this repository:
 *
 *   HANDOFF_COHORT_DIR=../migrate/.cohort-runs/<run> pnpm vitest run --project unit migration-handoff-cohort
 *
 * Each `<site>/.contentrain/migrate/handoff.json` (or the legacy
 * `<site>/contentrain-handoff.json`) must validate, and its manifest
 * (what Studio stores) must fit the ceiling with the comments export lifted
 * out. `HANDOFF_COHORT_REPORT=<file>` writes the per-site sizes as JSON.
 */

import type { MigrationHandoff } from '@contentrain/types'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HANDOFF_MANIFEST_MAX_BYTES,
  HANDOFF_PATH,
  LEGACY_HANDOFF_FILENAME,
  splitMigrationHandoff,
  summarizeMigrationHandoff,
  validateMigrationHandoff,
} from '../../server/utils/migration-handoff'

const dir = process.env.HANDOFF_COHORT_DIR

function handoffFile(site: string): string | undefined {
  return [HANDOFF_PATH, LEGACY_HANDOFF_FILENAME].find(file => existsSync(join(dir!, site, file)))
}

describe.skipIf(!dir)('migration handoff intake — real cohort handoffs', () => {
  it('validates every handoff and stores a manifest without the comments export', () => {
    const sites = readdirSync(dir!).filter(site => handoffFile(site))
    expect(sites.length).toBeGreaterThan(0)

    const rows = sites.map((site) => {
      const file = handoffFile(site)!
      const raw = readFileSync(join(dir!, site, file), 'utf8')
      const handoff = JSON.parse(raw) as MigrationHandoff
      expect(validateMigrationHandoff(handoff), site).toBeNull()

      const { manifest, manifestBytes } = splitMigrationHandoff(handoff, { path: file, ref: 'contentrain' }, Buffer.byteLength(raw))
      expect(manifestBytes, site).toBeLessThanOrEqual(HANDOFF_MANIFEST_MAX_BYTES)
      expect(manifest.comments?.export?.inline, site).toBeUndefined()

      const summary = summarizeMigrationHandoff(manifest)
      if (handoff.comments?.export?.inline) expect(summary.comments?.hasExport, site).toBe(true)
      return {
        site,
        fileBytes: Buffer.byteLength(raw),
        manifestBytes,
        comments: manifest.studio_intake?.comments.kind,
        issues: summary.issues.map(i => i.code),
      }
    })

    if (process.env.HANDOFF_COHORT_REPORT)
      writeFileSync(process.env.HANDOFF_COHORT_REPORT, `${JSON.stringify(rows, null, 2)}\n`)
  })
})
