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
  vi.stubGlobal('getPlanLimitForPlan', getPlanLimitForPlan)
  vi.stubGlobal('getUpgradeParams', (from: string, to: string) => ({ from, to }))
  vi.stubGlobal('errorMessage', (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key))
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), { statusCode: input.statusCode }))
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

  const REF = [{ file: '.contentrain/content/blog/posts/data.json', pointer: '/x/body', match: 'contains' }]
  const withRecommended = (list: unknown[]) => ({ ...golden, studioRecommended: list })

  it('reads studioRecommended (files over the repo caps, left at the old address) beside the assets', () => {
    const big = `${golden.origin}/wp-content/uploads/2026/01/big.mp4`
    const manifest = parseMigrationMediaManifest(withRecommended([{ url: big, reason: 'file-too-large', bytes: 120 * 1024 * 1024, refs: REF }]))
    expect(manifest.assets).toHaveLength(golden.assets.length)
    expect(manifest.onOrigin).toEqual([{ url: big, reason: 'file-too-large', bytes: 120 * 1024 * 1024, refs: REF }])
    expect(parseMigrationMediaManifest(golden).onOrigin).toEqual([])
  })

  it('refuses a studioRecommended entry that is not an http(s) address, or is listed twice', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', '/relative.png', 'not a url'])
      expect(() => parseMigrationMediaManifest(withRecommended([{ url, reason: 'count-cap', refs: [] }])), url).toThrow(/studioRecommended\[0\]\.url/)
    const twice = { url: `${golden.origin}/a.png`, reason: 'count-cap', refs: [] }
    expect(() => parseMigrationMediaManifest(withRecommended([twice, twice]))).toThrow(/listed twice/)
  })

  it('the preflight counts the old-site files: fetchable, over the file cap, or on another host', () => {
    const manifest = parseMigrationMediaManifest(withRecommended([
      { url: `${golden.origin}/wp-content/uploads/ok.png`, reason: 'count-cap', refs: REF },
      { url: `${golden.origin}/wp-content/uploads/sized.png`, reason: 'total-cap', bytes: 2000, refs: REF },
      { url: `${golden.origin}/wp-content/uploads/huge.mp4`, reason: 'file-too-large', bytes: 900 * 1024 * 1024, refs: REF },
      { url: 'https://cdn.elsewhere.test/x.png', reason: 'count-cap', refs: REF },
    ]))
    const tree = manifest.assets.map(a => ({ path: a.repoPath, type: 'blob' as const, sha: a.sha256.slice(0, 40), size: a.bytes }))
    const preflight = planMigrationMediaPreflight({ manifest, tree, plan: 'pro', usedBytes: 0 })
    expect(preflight.onOrigin).toEqual({ count: 2, knownBytes: 2000, overSize: [{ url: `${golden.origin}/wp-content/uploads/huge.mp4`, bytes: 900 * 1024 * 1024 }], offOrigin: 1, refs: 2 })
  })

  it('the preflight over the delivered tree: every media file found, the fonts kept in the site', () => {
    const manifest = parseMigrationMediaManifest(golden)
    const tree = manifest.assets.map(a => ({ path: a.repoPath, type: 'blob' as const, sha: a.sha256.slice(0, 40), size: a.bytes }))
    const preflight = planMigrationMediaPreflight({ manifest, tree, plan: 'pro', usedBytes: 0 })
    expect(preflight).toMatchObject({ count: 29, fontsKept: 2, missing: [], overSize: [], fits: true })
  })
})
