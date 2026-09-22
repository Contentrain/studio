import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mediaMethods } from '../../server/providers/postgres-db/media'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db media (contract)', () => {
  const methods = mediaMethods()
  let user: SeededUser
  let projectId: string

  function baseAsset(overrides: Record<string, unknown> = {}) {
    return {
      project_id: projectId,
      workspace_id: user.workspaceId,
      filename: 'photo.webp',
      content_type: 'image/webp',
      size_bytes: 2048,
      content_hash: randomUUID(),
      format: 'webp',
      original_path: `media/original/${randomUUID()}.webp`,
      uploaded_by: user.userId,
      ...overrides,
    }
  }

  beforeAll(async () => {
    user = await seedUser('media')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/media-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('asset lifecycle with jsonb round-trip (variants, focal_point)', async () => {
    const created = await methods.createMediaAsset(baseAsset({
      variants: { thumb: { path: 'media/thumb/x.webp', width: 200 } },
      focal_point: { x: 0.5, y: 0.3 },
      alt: 'A photo',
      tags: ['hero', 'landing'],
    }))

    expect(created.variants).toEqual({ thumb: { path: 'media/thumb/x.webp', width: 200 } })
    expect(created.focal_point).toEqual({ x: 0.5, y: 0.3 })
    expect(created.tags).toEqual(['hero', 'landing'])

    const fetched = await methods.getMediaAsset(created.id as string)
    expect(fetched!.filename).toBe('photo.webp')
    expect(await methods.getMediaAsset(randomUUID())).toBeNull()

    const updated = await methods.updateMediaAsset(created.id as string, { alt: 'Updated alt' })
    expect(updated.alt).toBe('Updated alt')
    expect(Date.parse(updated.updated_at as string)).toBeGreaterThanOrEqual(Date.parse(created.updated_at as string))

    const deleted = await methods.deleteMediaAsset(created.id as string)
    expect(deleted!.id).toBe(created.id)
    expect(await methods.deleteMediaAsset(created.id as string)).toBeNull()
  })

  it('findMediaAssetByContentHash: the project\'s asset for these bytes, oldest first, never another project\'s', async () => {
    // What makes bulk ingest idempotent across requests. The column has been
    // written since the baseline under a comment calling it duplicate
    // detection; this is the read that finally uses it.
    const hash = randomUUID()
    const first = await methods.createMediaAsset(baseAsset({ content_hash: hash, filename: 'first.webp' }))
    const second = await methods.createMediaAsset(baseAsset({
      content_hash: hash,
      filename: 'second.webp',
      created_at: new Date(Date.now() + 1000).toISOString(),
    }))

    // Oldest wins: if a project somehow holds two rows for the same bytes, the
    // one its content already references is the earlier one.
    const found = await methods.findMediaAssetByContentHash(projectId, hash)
    expect(found?.id).toBe(first.id)

    expect(await methods.findMediaAssetByContentHash(projectId, randomUUID())).toBeNull()
    // Tenant isolation: identical bytes in another project are not this
    // project's asset, and handing them over would leak a file across tenants.
    expect(await methods.findMediaAssetByContentHash(randomUUID(), hash)).toBeNull()

    await methods.deleteMediaAsset(first.id as string)
    await methods.deleteMediaAsset(second.id as string)
  })

  it('listMediaAssets: search, tag overlap, content-type prefix, sorts, pagination', async () => {
    const a = await methods.createMediaAsset(baseAsset({ filename: 'alpha.webp', alt: 'sunrise', tags: ['nature'], size_bytes: 100 }))
    const b = await methods.createMediaAsset(baseAsset({ filename: 'beta.mp4', content_type: 'video/mp4', format: 'mp4', tags: ['nature', 'clip'], size_bytes: 900, created_at: new Date(Date.now() + 1000).toISOString() }))

    const all = await methods.listMediaAssets(projectId)
    expect(all.total).toBe(2)
    expect(all.assets.map(x => x.id)).toEqual([b.id, a.id]) // newest first

    const search = await methods.listMediaAssets(projectId, { search: 'sunri' })
    expect(search.assets.map(x => x.id)).toEqual([a.id])

    const tagged = await methods.listMediaAssets(projectId, { tags: ['clip', 'other'] })
    expect(tagged.assets.map(x => x.id)).toEqual([b.id])

    const videos = await methods.listMediaAssets(projectId, { contentType: 'video/' })
    expect(videos.assets.map(x => x.id)).toEqual([b.id])

    const bySize = await methods.listMediaAssets(projectId, { sort: 'size' })
    expect(bySize.assets.map(x => x.id)).toEqual([b.id, a.id])

    const byName = await methods.listMediaAssets(projectId, { sort: 'name' })
    expect(byName.assets.map(x => x.id)).toEqual([a.id, b.id])

    const page2 = await methods.listMediaAssets(projectId, { limit: 1, page: 2 })
    expect(page2.total).toBe(2)
    expect(page2.assets).toHaveLength(1)
  })

  it('media usage tracking is idempotent and removable', async () => {
    const asset = await methods.createMediaAsset(baseAsset())
    const usage = {
      asset_id: asset.id as string,
      project_id: projectId,
      model_id: 'posts',
      entry_id: 'entry-1',
      field_id: 'cover',
      locale: 'en',
    }

    await methods.trackMediaUsage(usage)
    await methods.trackMediaUsage(usage) // duplicate → no second row

    const rows = await methods.getMediaUsage(asset.id as string)
    expect(rows).toEqual([{ model_id: 'posts', entry_id: 'entry-1', field_id: 'cover', locale: 'en' }])

    await methods.removeMediaUsage(usage)
    expect(await methods.getMediaUsage(asset.id as string)).toEqual([])
  })

  it('copyMediaAssetRows: copies the rows for the given paths to another project, skipping paths it already has', async () => {
    // The media rehost after a project id change (#321): rows follow the
    // copied storage objects, and a re-run must not add a second row.
    const target = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/media-rehost-target') RETURNING id
    `.execute(getDb())
    const targetId = target.rows[0]!.id

    const created = new Date(Date.now() - 86_400_000).toISOString()
    const a = await methods.createMediaAsset(baseAsset({
      original_path: 'media/original/rehost-a.webp',
      alt: 'Alt A',
      tags: ['hero'],
      variants: { thumb: { path: 'media/variants/rehost-a-320.webp', width: 320 } },
      focal_point: { x: 0.2, y: 0.8 },
      created_at: created,
    }))
    await methods.createMediaAsset(baseAsset({ original_path: 'media/original/rehost-b.webp' }))
    await methods.createMediaAsset(baseAsset({ original_path: 'media/original/rehost-c.webp' }))
    // Already listed on the target — must be skipped, not duplicated.
    await methods.createMediaAsset(baseAsset({ project_id: targetId, original_path: 'media/original/rehost-b.webp' }))

    const input = {
      fromProjectId: projectId,
      toProjectId: targetId,
      toWorkspaceId: user.workspaceId,
      originalPaths: ['media/original/rehost-a.webp', 'media/original/rehost-b.webp', 'media/original/not-there.webp'],
    }
    expect(await methods.copyMediaAssetRows(input)).toBe(1)
    expect(await methods.copyMediaAssetRows(input)).toBe(0)
    expect(await methods.copyMediaAssetRows({ ...input, originalPaths: [] })).toBe(0)

    expect((await methods.listMediaAssetPaths(targetId)).sort()).toEqual([
      'media/original/rehost-a.webp',
      'media/original/rehost-b.webp',
    ])
    const copied = await methods.findMediaAssetByPath(targetId, 'media/original/rehost-a.webp')
    expect(copied).toMatchObject({
      project_id: targetId,
      workspace_id: user.workspaceId,
      filename: a.filename,
      content_hash: a.content_hash,
      size_bytes: a.size_bytes,
      alt: 'Alt A',
      tags: ['hero'],
      variants: { thumb: { path: 'media/variants/rehost-a-320.webp', width: 320 } },
      focal_point: { x: 0.2, y: 0.8 },
      uploaded_by: user.userId,
    })
    expect(copied!.id).not.toBe(a.id)
    expect(new Date(copied!.created_at as string).toISOString()).toBe(created)
    // The source keeps its rows.
    expect(await methods.findMediaAssetByPath(projectId, 'media/original/rehost-a.webp')).toMatchObject({ id: a.id })
  })
})
