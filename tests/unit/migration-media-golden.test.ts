import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPlanLimitForPlan } from '../../shared/utils/license'
import { parseMigrationMediaManifest, planMigrationMediaPreflight } from '../../server/utils/migration-media'

/**
 * The media.json Migrate actually writes (golden tt5 run, local origin): the
 * parser takes it whole — fonts, sourceUrl, origin and the lists Studio does
 * not read yet (studioRecommended, withheld) — and the preflight counts it.
 */
const golden = JSON.parse(readFileSync(new URL('../fixtures/migration/golden-media.json', import.meta.url), 'utf8')) as Record<string, unknown> & { assets: Array<Record<string, unknown>> }

beforeEach(() => {
  // The real plan table: the golden set must fit a plan that sells media.
  vi.stubGlobal('getPlanLimit', (plan: string, key: string) => getPlanLimitForPlan(plan, key))
})

describe('Migrate\'s golden media.json', () => {
  it('parses whole: every asset, role, ref and source address', () => {
    const manifest = parseMigrationMediaManifest(golden)
    expect(manifest.origin).toBe(golden.origin)
    expect(manifest.assets).toHaveLength(golden.assets.length)
    expect(manifest.assets.filter(a => a.role === 'media')).toHaveLength(29)
    expect(manifest.assets.filter(a => a.role === 'font')).toHaveLength(2)
    expect(manifest.assets.reduce((n, a) => n + a.refs.length, 0)).toBe(golden.assets.reduce((n, a) => n + (a.refs as unknown[]).length, 0))
    for (const [i, asset] of manifest.assets.entries()) {
      const raw = golden.assets[i]!
      expect(asset).toMatchObject({ id: raw.id, repoPath: raw.repoPath, sha256: raw.sha256, bytes: raw.bytes, mime: raw.mime, sourceUrl: raw.sourceUrl })
    }
  })

  it('a studioRecommended entry (a file over the repo caps, left at its old address) does not trip the parser', () => {
    const withRecommended = {
      ...golden,
      studioRecommended: [{ url: `${golden.origin}/wp-content/uploads/2026/01/big.mp4`, reason: 'file-too-large', bytes: 120 * 1024 * 1024, refs: [{ file: '.contentrain/content/blog/posts/data.json', pointer: '/x/body', match: 'contains' }] }],
    }
    expect(parseMigrationMediaManifest(withRecommended).assets).toHaveLength(golden.assets.length)
  })

  it('the preflight over the delivered tree: every media file found, the fonts kept in the site', () => {
    const manifest = parseMigrationMediaManifest(golden)
    const tree = manifest.assets.map(a => ({ path: a.repoPath, type: 'blob' as const, sha: a.sha256.slice(0, 40), size: a.bytes }))
    const preflight = planMigrationMediaPreflight({ manifest, tree, plan: 'pro', usedBytes: 0 })
    expect(preflight).toMatchObject({ count: 29, fontsKept: 2, missing: [], overSize: [], fits: true })
  })
})
